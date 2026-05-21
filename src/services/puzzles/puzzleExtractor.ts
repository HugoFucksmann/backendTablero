import { StockfishProcess } from '../../core/stockfishProcess.js';
import { ChessMath } from '../../utils/chessMath.js';
import { EvaluationEngine } from '../analysis/evaluationRules.js';
import { buildPositions, parsePgn } from '../../utils/analysisUtils.js';
import { PuzzleStore } from '../../storage/puzzleStore.js';
import { DataMiner } from '../analysis/dataMiner.js';
import { evaluatePuzzleCandidate, isTacticalMove, allowsMate } from './puzzleFilters.js';
import { SqliteStore } from '../../storage/sqliteStore.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_WP_LOSS_FOR_PUZZLE = 0.15;
const PUZZLE_LABELS = new Set(['Error', 'Error grave']);
const LIGHT_SCAN_DEPTH = 16;
const HEAVY_VAL_DEPTH = 20;

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface PuzzleExtractionGame {
    pgn: string;
    history?: any[] | null;
    gameId: string;
    startFen?: string | null;
}

export interface PuzzleExtractionCallbacks {
    onGameDone?: (progress: { gameIndex: number; total: number; extractedCount: number; totalExtracted: number }) => void;
    onComplete?: (result: { totalExtracted: number }) => void;
    onCancelled?: (result: { totalExtracted: number }) => void;
    onError?: (err: Error) => void;
}

export interface ExtractionEngineConfig {
    depth?: number;
    threads?: number;
    hash?: number;
}

interface LightEvalResult {
    wp: number;
    bestMove: string;
    mate: number | null;
}

interface CandidatePuzzle {
    ply: number;
    beforeEval: LightEvalResult;
    isWhiteMove: boolean;
    movePlayed: string;
    isEngineBest: boolean;
    puzzleFen: string;
    preBlunderFen: string;
    label: string;
}

export class PuzzleExtractor {
    private _running: boolean;
    private _ac: AbortController | null;

    constructor() {
        this._running = false;
        this._ac = null;
    }

    public cancel(): void {
        this._running = false;
        if (this._ac) {
            this._ac.abort();
            this._ac = null;
        }
    }

    public destroy(): void {
        this.cancel();
    }

    /**
     * Entry point for extraction. Processes multiple games.
     */
    public async extractFromGames(
        games: PuzzleExtractionGame[],
        engineConfig: ExtractionEngineConfig = {},
        callbacks: PuzzleExtractionCallbacks = {}
    ): Promise<void> {
        const { onGameDone, onComplete, onCancelled, onError } = callbacks;

        if (this._running) this.cancel();
        this._ac = new AbortController();
        const { signal } = this._ac;
        this._running = true;

        const depth = engineConfig.depth ?? HEAVY_VAL_DEPTH;
        const threads = engineConfig.threads ?? 1;
        const hash = engineConfig.hash ?? 128;

        const numEngines = Math.min(3, Math.max(1, threads));
        const threadsPerEngine = Math.max(1, Math.floor(threads / numEngines));
        const hashPerEngine = Math.min(256, Math.max(16, Math.floor(hash / numEngines)));

        console.log(`[Puzzle] Starting extraction: ${games.length} game(s) | Depth: ${depth} | Parallel Engines: ${numEngines} | Threads per Engine: ${threadsPerEngine} | Hash per Engine: ${hashPerEngine}MB`);

        const engines = Array.from({ length: numEngines }, () => new StockfishProcess());
        const cleanupEngines = () => engines.forEach(e => e.destroy());

        try {
            await Promise.all(
                engines.map(e =>
                    e.init({
                        depth,
                        threads: threadsPerEngine,
                        hash: hashPerEngine,
                        multiPv: 1
                    })
                )
            );

            let totalExtracted = 0;
            for (let i = 0; i < games.length; i++) {
                if (signal.aborted) break;

                const { pgn, history: rawHistory, gameId, startFen: rawStartFen } = games[i];
                
                const { history, startFen } = (rawHistory && Array.isArray(rawHistory)) 
                    ? { history: rawHistory, startFen: rawStartFen ?? null } 
                    : parsePgn(pgn);

                if (!history || history.length === 0) continue;

                const extracted = await this._processGame(history, gameId, depth, engines, signal, startFen);
                if (signal.aborted) break;

                totalExtracted += extracted;
                onGameDone?.({ gameIndex: i, total: games.length, extractedCount: extracted, totalExtracted });
            }

            if (!signal.aborted) onComplete?.({ totalExtracted });
            else onCancelled?.({ totalExtracted });

        } catch (e: any) {
            if (e.name !== 'AbortError') {
                console.error('[Puzzle] Extraction Error:', e.message);
                onError?.(e);
            }
        } finally {
            cleanupEngines();
            this._running = false;
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async _processGame(
        history: any[],
        gameId: string,
        depth: number,
        engines: StockfishProcess[],
        signal: AbortSignal,
        startFen: string | null
    ): Promise<number> {
        if (!history || history.length === 0) return 0;

        const positions = buildPositions(history, startFen);
        engines.forEach(e => e.newGame());

        let lightEvalResults: (LightEvalResult | null)[] | null = null;

        // Intentar bypass de base de datos para Fase 1 si la partida ya fue analizada a suficiente profundidad
        try {
            const fullData = SqliteStore.getFull(gameId);

            if (fullData && Array.isArray(fullData.evaluations) && fullData.evaluations.length > 0) {
                // Comprobamos la profundidad de análisis previo usando la primera evaluación válida
                const sampleEval = fullData.evaluations.find((e: any) => e && e.lines && e.lines[0] && typeof e.lines[0].depth === 'number');
                const prevDepth = sampleEval ? sampleEval.lines[0].depth : 0;

                if (prevDepth >= 16) {
                    console.log(`[Puzzle] Database Bypass: Game ${gameId} has existing analysis at sufficient depth (${prevDepth}). Skipping Light Scan.`);
                    lightEvalResults = fullData.evaluations.map((e: any) => {
                        if (!e) return { wp: 0.5, bestMove: '', mate: null };
                        return {
                            wp: e.wp ?? 0.5,
                            bestMove: e.bestMove ?? '',
                            mate: e.mate ?? null
                        };
                    });
                } else {
                    console.log(`[Puzzle] Game ${gameId} has analysis but at insufficient depth (${prevDepth} < 16). Running full Light Scan.`);
                }
            }
        } catch (err: any) {
            console.warn('[Puzzle] Failed to check database for bypass:', err.message);
        }

        if (!lightEvalResults) {
            // Phase 1: Scan for blunders using light analysis
            lightEvalResults = await this._runLightScan(positions, engines, signal);
            if (signal.aborted) return 0;
        }

        // Phase 2: Filter and validate candidates with heavy analysis
        const candidates = this._identifyCandidates(history, positions, lightEvalResults);
        if (candidates.length === 0) return 0;

        return await this._validateCandidates(candidates, history, positions, engines, signal, depth, gameId);
    }

    private async _runLightScan(positions: string[], engines: StockfishProcess[], signal: AbortSignal): Promise<(LightEvalResult | null)[]> {
        const results = new Array<(LightEvalResult | null)>(positions.length).fill(null);
        let currentIdx = 0;

        const workers = engines.map(async (engine) => {
            while (true) {
                if (signal.aborted) break;
                const idx = currentIdx++;
                if (idx >= positions.length) break;

                const fen = positions[idx];
                try {
                    const raw = await engine.analyzePosition(fen, LIGHT_SCAN_DEPTH, signal, null, 1);
                    if (signal.aborted) break;

                    results[idx] = {
                        wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, fen.includes(' b ')),
                        bestMove: raw.bestMove,
                        mate: raw.mate ?? null
                    };
                } catch (e: any) {
                    if (e.name === 'AbortError') break;
                    results[idx] = { wp: 0.5, bestMove: '', mate: null };
                }
            }
        });

        await Promise.all(workers);
        return results;
    }

    private _identifyCandidates(history: any[], positions: string[], lightEvalResults: (LightEvalResult | null)[]): CandidatePuzzle[] {
        const candidates: CandidatePuzzle[] = [];
        for (let ply = 0; ply < history.length; ply++) {
            const before = lightEvalResults[ply];
            const after = lightEvalResults[ply + 1];
            if (!before || !after) continue;

            const isWhiteMove = !positions[ply].includes(' b ');
            const movePlayed = typeof history[ply] === 'string' ? history[ply] : (history[ply].lan ?? history[ply].san);
            const isEngineBest = before.bestMove === movePlayed;

            const label = EvaluationEngine.classifyMove(before.wp, after.wp, isWhiteMove, isEngineBest);
            if (!PUZZLE_LABELS.has(label)) continue;

            const wpLoss = isWhiteMove ? (before.wp - after.wp) : (after.wp - before.wp);
            if (wpLoss < MIN_WP_LOSS_FOR_PUZZLE) continue;

            if (!allowsMate(after.mate) && !isTacticalMove(positions[ply + 1], after.bestMove)) continue;

            candidates.push({ 
                ply, 
                beforeEval: before, 
                isWhiteMove, 
                movePlayed, 
                isEngineBest, 
                puzzleFen: positions[ply + 1], 
                preBlunderFen: positions[ply], 
                label 
            });
        }
        return candidates;
    }

    private async _validateCandidates(
        candidates: CandidatePuzzle[],
        history: any[],
        positions: string[],
        engines: StockfishProcess[],
        signal: AbortSignal,
        depth: number,
        gameId: string
    ): Promise<number> {
        let extracted = 0;
        let currentCandidateIdx = 0;

        const workers = engines.map(async (engine) => {
            while (true) {
                if (signal.aborted) break;
                const idx = currentCandidateIdx++;
                if (idx >= candidates.length) break;

                const c = candidates[idx];
                try {
                    const raw = await engine.analyzePosition(c.puzzleFen, depth, signal, null, 2);
                    if (signal.aborted) break;

                    if (!raw || typeof raw.score === 'undefined') {
                        throw new Error('Incomplete engine result');
                    }

                    const afterHeavy = {
                        wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, c.puzzleFen.includes(' b ')),
                        pv: raw.lines?.[0]?.pv ?? '',
                        mate: raw.mate ?? null,
                        line1Score: raw.lines?.[0]?.score ?? raw.score ?? 0,
                        line2Score: raw.lines?.[1]?.score ?? null,
                        lines: raw.lines || []
                    };

                    const wpLoss = c.isWhiteMove ? (c.beforeEval.wp - afterHeavy.wp) : (afterHeavy.wp - c.beforeEval.wp);
                    
                    if (wpLoss < MIN_WP_LOSS_FOR_PUZZLE) continue;

                    const validation = evaluatePuzzleCandidate({ ...c, afterEval: afterHeavy, wpLoss });
                    if (!validation.accept) continue;

                    const severity = DataMiner.calculateBlunderSeverity(c.beforeEval.wp, afterHeavy.wp, c.isWhiteMove);
                    const tension = DataMiner.calculateTension(c.preBlunderFen);
                    const onlyMove = DataMiner.detectOnlyMove(
                        afterHeavy.lines[0] ?? { score: raw.score, mate: raw.mate },
                        afterHeavy.lines[1] ?? null,
                        !c.isWhiteMove
                    );
                    if (onlyMove.discard) continue; // Descartar puzzles inválidos de jugada única desastrosa
                    const motifs = DataMiner.extractTacticalMotifs(c.puzzleFen, validation.solutionSequence ?? []);

                    this._savePuzzle(c, validation, history, positions, gameId, wpLoss, { severity, tension, onlyMove, motifs });
                    extracted++;
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        console.error(`[Puzzle] Candidate validation failed at ply ${c.ply}:`, e.message);
                    }
                }
            }
        });

        await Promise.all(workers);
        return extracted;
    }

    private _savePuzzle(
        c: CandidatePuzzle,
        v: any,
        history: any[],
        positions: string[],
        gameId: string,
        finalWpLoss: number,
        minedData: any
    ): void {
        const playerColor = c.isWhiteMove ? 'black' : 'white';
        const mapMove = (m: any) => typeof m === 'string' ? m : (m.lan ?? m.san);
        const startIndex = Math.max(0, c.ply - 2);
        
        PuzzleStore.save({
            fen: c.puzzleFen,
            baseFen: positions[startIndex],
            contextMoves: history.slice(startIndex, c.ply).map(mapMove),
            originalContinuation: history.slice(c.ply + 1, c.ply + 1 + v.solutionSequence.length).map(mapMove),
            preBlunderFen: c.preBlunderFen,
            solutionSequence: v.solutionSequence,
            playedMove: c.movePlayed,
            label: c.label,
            puzzleType: v.puzzleType,
            mateIn: v.mateIn ?? null,
            wpLoss: parseFloat(finalWpLoss.toFixed(4)),
            preBlunderWp: parseFloat(c.beforeEval.wp.toFixed(4)),
            playerColor,
            gameId,
            ply: c.ply,
            // Enriched Data
            blunderSeverity: minedData.severity,
            tensionIndex: minedData.tension.tensionIndex,
            attackedSquares: minedData.tension.attackedSquaresCount,
            isOnlyMove: minedData.onlyMove.isOnlyMove,
            criticalityGap: minedData.onlyMove.criticalityGap,
            tacticalMotifs: minedData.motifs
        });
    }
}
export default PuzzleExtractor;
