import { EvaluationEngine } from './evaluationRules.js';
import { OpeningService, DetectedOpeningResult } from '../openings/openingService.js';
import { buildPositions, buildAnalysisOrder, EngineLine, EvaluationResult, ClassifiedMoveData } from '../../utils/analysisUtils.js';
import { MoveClassifier } from './moveClassifier.js';
import { PhaseDetector } from '../../utils/phaseDetector.js';
import { GameStore } from '../../storage/gameStore.js';
import { EnginePool, EnginePoolConfig } from './enginePool.js';
import { AnalysisWorkerLoop } from './analysisWorkerLoop.js';
import { calculate as calcMetrics, PhaseAccuracyResult } from './advancedMetricsCalculator.js';
import { build as buildPersistence } from './persistenceBuilder.js';
import { StockfishProcess } from '../../core/stockfishProcess.js';
import { Move } from 'chess.js';

export interface MoveAnalysisProgress {
    index: number;
    score: number | string;
    mate: number | null;
    bestMove: string;
    lines: EngineLine[];
}

export interface MoveAnalysisClassification {
    index: number;
    label: string;
    isBook: boolean;
    errorTimeClass: 'time_pressure' | 'precipitation' | 'overthinking' | null;
}

export interface GameAnalysisCallbacks {
    onStatus?: (active: boolean) => void;
    onProgress?: (pct: number, label: string) => void;
    onMoveResult?: (data: MoveAnalysisProgress | MoveAnalysisClassification) => void;
    onOpeningDetected?: (data: DetectedOpeningResult) => void;
    onComplete?: (accuracy: { white: number; black: number }, accuracyByPhase?: PhaseAccuracyResult[], win?: number | null) => void;
    onError?: (err: Error) => void;
    signal: AbortSignal;
    startFen?: string | null;
}

export interface GameAnalysisExtraInfo {
    times?: number[];
    playerWhite?: string | null;
    playerBlack?: string | null;
    playerColor?: 'white' | 'black';
    gameDate?: string | null;
    opponent?: string | null;
    win?: boolean | number | null;
    timeControl?: string | null;
    username?: string | null;
}

export class GameAnalysisCoordinator {
    constructor() { }

    public async run(
        history: (string | Move)[],
        currentIndex: number,
        gameId: string,
        engineConfig: EnginePoolConfig = {},
        callbacks: GameAnalysisCallbacks,
        extraInfo: GameAnalysisExtraInfo = {},
        prebuiltEngines: StockfishProcess[] | null = null
    ): Promise<void> {
        const {
            onStatus, onProgress, onMoveResult,
            onOpeningDetected, onComplete, signal, startFen,
        } = callbacks;

        const depth = engineConfig.depth ?? 18;
        const multiPv = engineConfig.multiPv ?? 1;
        const t0 = Date.now();

        let detectedOpening = 'Unknown';
        let detectedEco = '';

        const times = extraInfo.times || [];
        const playerWhite = extraInfo.playerWhite || null;
        const playerBlack = extraInfo.playerBlack || null;
        const playerColor = extraInfo.playerColor || 'white';
        const gameDate = extraInfo.gameDate || null;

        // Derivar oponente: usa el campo explícito si existe,
        // si no, lo deduce de los nombres de jugador y el color del usuario.
        let opponent = extraInfo.opponent || null;
        if (!opponent && (playerWhite || playerBlack)) {
            opponent = playerColor === 'white' ? playerBlack : playerWhite;
        }

        // Normalizar win: booleano (Lichess) o número (1/0/-1)
        const winNormalized = extraInfo.win === undefined || extraInfo.win === null
            ? null
            : (typeof extraInfo.win === 'boolean'
                ? (extraInfo.win ? 1 : -1)
                : (extraInfo.win === 0 ? 0 : (extraInfo.win > 0 ? 1 : -1)));

        // ── Pool de engines ───────────────────────────────────────────────────
        const pool = new EnginePool(engineConfig, prebuiltEngines);

        console.log(
            `[Game] Starting analysis: id=${gameId} | ${history.length} moves | ` +
            `Depth: ${depth} | MultiPV: ${multiPv} | ` +
            `Engines: ${pool.count} | Reused: ${!pool.ownsEngines}`
        );

        try {
            await pool.init();

            if (signal.aborted) return;

            onStatus?.(true);
            onProgress?.(0, 'Analizando…');
            pool.newGame();

            // ── Estado compartido entre apertura y workers ────────────────────
            const positions = buildPositions(history, startFen);
            const totalMoves = history.length;
            const bookStatus = new Array<boolean | null>(totalMoves).fill(null);
            const completedSet = new Set<number>();
            const finalMoveData = new Array<ClassifiedMoveData | undefined>(totalMoves);
            const labelCounts: Record<string, number> = {};

            const openingState = { done: false };

            // evalResultsRef se rellena de forma lazy por el worker loop
            const evalResultsRef: (EvaluationResult | undefined)[] = [];

            // Clasificar una jugada en cuanto tenga apertura + evaluación
            const tryClassify = (ply: number) => {
                this._tryClassify(
                    ply, history, positions, evalResultsRef,
                    bookStatus, openingState, finalMoveData,
                    completedSet, onMoveResult, labelCounts, times
                );
            };

            // ── Apertura (paralela al análisis del motor) ─────────────────────
            const openingPromise = OpeningService.detectOpenings({
                positions, history, gameId,
                signal,
                onPlyResolved: (ply, isBook) => {
                    bookStatus[ply] = isBook;
                    tryClassify(ply);
                },
                onOpeningDetected: (data) => {
                    if (data?.openingName) detectedOpening = data.openingName;
                    if (data?.ecoCode) detectedEco = data.ecoCode;
                    onOpeningDetected?.(data);
                },
            });

            openingPromise
                .catch(() => { })
                .finally(() => {
                    if (signal.aborted) return;
                    openingState.done = true;
                    for (let i = 0; i < totalMoves; i++) {
                        tryClassify(i);
                    }
                });

            // ── Worker loop ───────────────────────────────────────────────────
            const order = buildAnalysisOrder(positions.length, currentIndex);

            const workerLoop = new AnalysisWorkerLoop({
                positions,
                engines: pool.engines,
                depth,
                multiPv,
                signal,
                order,
                onEvalReady: (posIdx, evalResult) => {
                    evalResultsRef[posIdx] = evalResult;

                    onMoveResult?.({
                        index: posIdx === 0 ? -1 : posIdx - 1,
                        score: evalResult.score,
                        mate: evalResult.mate,
                        bestMove: evalResult.bestMove,
                        lines: evalResult.lines,
                    });

                    // Intentar clasificar la jugada previa y la actual
                    tryClassify(posIdx - 1);
                    tryClassify(posIdx);
                },
                onProgress: (evaluated, total) => {
                    const pct = Math.round((evaluated / total) * 100);
                    onProgress?.(Math.min(99, pct), `Analyzing (${pct}%)`);
                },
            });

            await workerLoop.run();

            if (!signal.aborted) {
                await openingPromise.catch(() => { });
            }

            // ── Finalización ──────────────────────────────────────────────────
            if (signal.aborted) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.log(`[Game] Analysis cancelled after ${elapsed}s | id=${gameId}`);
                return;
            }

            const accuracy = EvaluationEngine.calculateAccuracy(finalMoveData);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`[Game] Analysis completed in ${elapsed}s | Accuracy: W:${accuracy.white}% B:${accuracy.black}%`);

            // ── Métricas avanzadas ────────────────────────────────────────────
            const { accuracyByPhase, advancedMetrics } = calcMetrics({
                finalMoveData,
                evalResults: evalResultsRef,
                playerColor: extraInfo.playerColor || 'white',
                winNormalized: winNormalized ?? 0,
            });

            // ── Persistencia ──────────────────────────────────────────────────
            try {
                const { fullData, movesToSave } = buildPersistence({
                    gameId,
                    history,
                    positions,
                    evalResults: evalResultsRef,
                    finalMoveData,
                    completedSet,
                    accuracy,
                    accuracyByPhase,
                    opening: { name: detectedOpening, eco: detectedEco },
                    players: { white: playerWhite, black: playerBlack },
                    startFen,
                    win: winNormalized,
                    playerColor,
                });

                await GameStore.save({
                    gameId,
                    username: extraInfo.username || null,
                    white: { accuracy: accuracy.white },
                    black: { accuracy: accuracy.black },
                    opening: detectedOpening,
                    eco: detectedEco,
                    moveCount: totalMoves,
                    date: new Date().toISOString(),
                    color: playerColor,
                    win: winNormalized,
                    timeControl: extraInfo.timeControl || null,
                    accuracyByPhase,
                    labelCounts,
                    advancedMetrics,
                    moves: movesToSave,
                    opponent,
                    gameDate,
                }, fullData);

            } catch (e: any) {
                console.error('[Game] Failed to save analysis:', e.message);
            }

            onComplete?.(accuracy, accuracyByPhase, winNormalized);
            onProgress?.(100, 'Analysis completed');

        } finally {
            pool.destroy();
            onStatus?.(false);
        }
    }

    // ── Clasificación de jugadas ──────────────────────────────────────────────

    /**
     * Intenta clasificar la jugada `ply` si tiene todos los datos disponibles
     * (evaluación antes y después, y estado de apertura resuelto).
     * Idempotente: si ya fue clasificada, no hace nada.
     */
    private _tryClassify(
        ply: number,
        history: (string | Move)[],
        positions: string[],
        evalResults: (EvaluationResult | undefined)[],
        bookStatus: (boolean | null)[],
        openingState: { done: boolean },
        finalMoveData: (ClassifiedMoveData | undefined)[],
        completedSet: Set<number>,
        onMoveResult: ((data: MoveAnalysisProgress | MoveAnalysisClassification) => void) | undefined,
        labelCounts: Record<string, number>,
        times: number[]
    ): void {
        if (completedSet.has(ply)) return;

        let moveTime: number | undefined = undefined;
        let remainingTime: number | undefined = undefined;

        if (times && times.length > ply) {
            remainingTime = times[ply];
            if (ply >= 2 && times[ply - 2] !== undefined && times[ply - 2] !== null && times[ply] !== undefined && times[ply] !== null) {
                moveTime = times[ply - 2] - times[ply];
            }
        }

        const result = MoveClassifier.classify({
            ply,
            history,
            positions,
            evalResults,
            bookStatus,
            openingDone: openingState.done,
            moveTime,
            remainingTime,
        });

        if (!result) return;

        const { label, isBook, wpLoss, isWhiteMove, errorTimeClass } = result;
        onMoveResult?.({ index: ply, label, isBook, errorTimeClass });

        let phase = 'Medio Juego';
        if (isBook) {
            phase = 'Apertura';
        } else {
            phase = PhaseDetector.detect(ply, positions[ply], false);
            labelCounts[label] = (labelCounts[label] ?? 0) + 1;
        }

        finalMoveData[ply] = {
            label,
            isWhiteMove,
            wpLoss,
            isBook,
            phase,
            moveTime,
            remainingTime,
            errorTimeClass,
            fen: positions[ply + 1],
        };
        completedSet.add(ply);
    }
}
export default GameAnalysisCoordinator;
