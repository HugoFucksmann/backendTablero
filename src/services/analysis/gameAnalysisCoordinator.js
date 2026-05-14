'use strict';

const { EvaluationEngine } = require('./evaluationRules');
const { OpeningService } = require('../openings/openingService');
const { buildPositions, buildAnalysisOrder } = require('../../utils/analysisUtils');
const { MoveClassifier } = require('./moveClassifier');
const { PhaseDetector } = require('../../utils/phaseDetector');
const { GameStore } = require('../../storage/gameStore');

const { EnginePool } = require('./enginePool');
const { AnalysisWorkerLoop } = require('./analysisWorkerLoop');
const { calculate: calcMetrics } = require('./advancedMetricsCalculator');
const { build: buildPersistence } = require('./persistenceBuilder');

/**
 * GameAnalysisCoordinator
 * ───────────────────────
 * Orquestador puro: coordina el flujo de análisis sin implementar
 * ninguna lógica de negocio directamente.
 *
 * Responsabilidades:
 *   1. Inicializar y liberar el EnginePool.
 *   2. Lanzar la detección de apertura y el loop de workers en paralelo.
 *   3. Delegar clasificación, métricas y persistencia a sus módulos.
 *   4. Emitir callbacks de progreso al caller.
 */
class GameAnalysisCoordinator {
    constructor() { }

    async run(history, currentIndex, gameId, engineConfig = {}, callbacks = {}, extraInfo = {}, prebuiltEngines = null) {
        const {
            onStatus, onProgress, onMoveResult,
            onOpeningDetected, onComplete, onError, signal, startFen,
        } = callbacks;

        const depth = engineConfig.depth ?? 18;
        const multiPv = engineConfig.multiPv ?? 1;
        const t0 = Date.now();

        let detectedOpening = 'Unknown';
        let detectedEco = '';

        const times = extraInfo.times || [];
        const playerWhite = extraInfo.playerWhite || null;
        const playerBlack = extraInfo.playerBlack || null;

        // Normalizar win: booleano (Lichess) o número (1/0/-1)
        const winNormalized = typeof extraInfo.win === 'boolean'
            ? (extraInfo.win ? 1 : -1)
            : (extraInfo.win === 0 ? 0 : (extraInfo.win > 0 ? 1 : -1));

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
            const bookStatus = new Array(totalMoves).fill(null);
            const completedSet = new Set();
            const finalMoveData = new Array(totalMoves);
            const labelCounts = {};
            const openingState = { done: false };

            // Clasificar una jugada en cuanto tenga apertura + evaluación
            const tryClassify = (ply) =>
                this._tryClassify(
                    ply, history, positions, evalResultsRef,
                    bookStatus, openingState, finalMoveData,
                    completedSet, onMoveResult, labelCounts, times
                );

            // evalResultsRef se rellena de forma lazy por el worker loop
            let evalResultsRef = [];

            // ── Apertura (paralela al análisis del motor) ─────────────────────
            const openingPromise = OpeningService.detectOpenings({
                positions, history, gameId,
                token: engineConfig.lichessToken || process.env.LICHESS_TOKEN,
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
                    for (let i = 0; i < totalMoves; i++) tryClassify(i);
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

            evalResultsRef = await workerLoop.run();

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
                winNormalized,
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
                    opening: { name: detectedOpening, eco: detectedEco },
                    players: { white: playerWhite, black: playerBlack },
                    startFen,
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
                    color: extraInfo.playerColor || 'white',
                    win: winNormalized,
                    timeControl: extraInfo.timeControl || null,
                    accuracyByPhase,
                    labelCounts,
                    advancedMetrics,
                    moves: movesToSave,
                }, fullData);

            } catch (e) {
                console.error('[Game] Failed to save analysis:', e.message);
            }

            onComplete?.(accuracy);
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
    _tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult, labelCounts, times) {
        if (completedSet.has(ply)) return;

        let moveTime = undefined;
        let remainingTime = undefined;

        if (times?.length > ply) {
            remainingTime = times[ply];
            if (ply >= 2 && times[ply - 2] !== undefined) {
                moveTime = times[ply - 2] - times[ply];
            }
        }

        const result = MoveClassifier.classify({
            ply, history, positions, evalResults,
            bookStatus, openingDone: openingState.done,
            moveTime, remainingTime,
        });

        if (!result) return;

        const { label, isBook, wpLoss, isWhiteMove } = result;
        onMoveResult?.({ index: ply, label, isBook });

        let phase = 'Medio Juego';
        if (isBook) {
            phase = 'Apertura';
        } else {
            phase = PhaseDetector.detect(ply, positions[ply], false);
            labelCounts[label] = (labelCounts[label] ?? 0) + 1;
        }

        finalMoveData[ply] = {
            label, isWhiteMove, wpLoss, isBook, phase,
            moveTime, remainingTime,
            // positions[ply+1] = posición DESPUÉS del movimiento ply
            fen: positions[ply + 1],
        };
        completedSet.add(ply);
    }
}

module.exports = { GameAnalysisCoordinator };