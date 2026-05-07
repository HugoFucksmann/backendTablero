'use strict';

const { StockfishProcess } = require('../../core/stockfishProcess');
const { ChessMath } = require('../../utils/chessMath');
const { EvaluationEngine } = require('../analysis/evaluationRules');
const { buildPositions, parsePgn } = require('../../utils/analysisUtils');
const { PuzzleStore } = require('../../storage/puzzleStore');
const { DataMiner } = require('../analysis/dataMiner');
const { evaluatePuzzleCandidate, isTacticalMove, allowsMate } = require('./puzzleFilters');

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_WP_LOSS_FOR_PUZZLE = 0.15;
const PUZZLE_LABELS = new Set(['Error', 'Error grave']);
const LIGHT_SCAN_DEPTH = 16;
const HEAVY_VAL_DEPTH = 20;

/**
 * PuzzleExtractor
 * ───────────────
 * Responsibility: Orchestrates the detection and validation of chess puzzles from games.
 * Uses a two-phase analysis approach (Light Scan + Heavy Validation).
 */
class PuzzleExtractor {
    constructor() {
        this._running = false;
        this._ac = null;
    }

    cancel() {
        this._running = false;
        if (this._ac) {
            this._ac.abort();
            this._ac = null;
        }
    }

    destroy() {
        this.cancel();
    }

    /**
     * Entry point for extraction. Processes multiple games.
     */
    async extractFromGames(games, engineConfig = {}, callbacks = {}) {
        const { onGameDone, onComplete, onCancelled, onError } = callbacks;

        if (this._running) this.cancel();
        this._ac = new AbortController();
        const { signal } = this._ac;
        this._running = true;

        const depth = engineConfig.depth ?? HEAVY_VAL_DEPTH;
        const threads = engineConfig.threads ?? 1;
        const hash = engineConfig.hash ?? 128;

        const numEngines = Math.max(1, threads);
        const hashPerEngine = Math.max(16, Math.floor(hash / numEngines));

        console.log(`[Puzzle] Starting extraction: ${games.length} game(s) | Depth: ${depth} | Parallel Engines: ${numEngines}`);

        const engines = Array.from({ length: numEngines }, () => new StockfishProcess());
        const cleanupEngines = () => engines.forEach(e => e.destroy());

        try {
            await Promise.all(engines.map(e => e.init({ ...engineConfig, threads: 1, hash: hashPerEngine, multiPv: 1 })));

            let totalExtracted = 0;
            for (let i = 0; i < games.length; i++) {
                if (signal.aborted) break;

                const { pgn, history: rawHistory, gameId, startFen: rawStartFen } = games[i];
                
                let { history, startFen } = (rawHistory && Array.isArray(rawHistory)) 
                    ? { history: rawHistory, startFen: rawStartFen } 
                    : parsePgn(pgn);

                if (!history || history.length === 0) continue;

                const extracted = await this._processGame(history, gameId, depth, engines, signal, startFen);
                if (signal.aborted) break;

                totalExtracted += extracted;
                onGameDone?.({ gameIndex: i, total: games.length, extractedCount: extracted, totalExtracted });
            }

            if (!signal.aborted) onComplete?.({ totalExtracted });
            else onCancelled?.({ totalExtracted });

        } catch (e) {
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

    async _processGame(history, gameId, depth, engines, signal, startFen) {
        if (!history || history.length === 0) return 0;

        const positions = buildPositions(history, startFen);
        engines.forEach(e => e.newGame());

        // Phase 1: Scan for blunders using light analysis
        const lightEvalResults = await this._runLightScan(positions, engines, signal);
        if (signal.aborted) return 0;

        // Phase 2: Filter and validate candidates with heavy analysis
        const candidates = this._identifyCandidates(history, positions, lightEvalResults);
        if (candidates.length === 0) return 0;

        return await this._validateCandidates(candidates, history, positions, engines, signal, depth, gameId);
    }

    async _runLightScan(positions, engines, signal) {
        const results = new Array(positions.length).fill(null);
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
                } catch (e) {
                    if (e.name === 'AbortError') break;
                    results[idx] = { wp: 0.5, bestMove: null, mate: null };
                }
            }
        });

        await Promise.all(workers);
        return results;
    }

    _identifyCandidates(history, positions, lightEvalResults) {
        const candidates = [];
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

            // Note: using 'beforeEval' to match evaluatePuzzleCandidate expectations
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

    async _validateCandidates(candidates, history, positions, engines, signal, depth, gameId) {
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
                    };

                    const wpLoss = c.isWhiteMove ? (c.beforeEval.wp - afterHeavy.wp) : (afterHeavy.wp - c.beforeEval.wp);
                    
                    if (wpLoss < MIN_WP_LOSS_FOR_PUZZLE) continue;

                    const validation = evaluatePuzzleCandidate({ ...c, afterEval: afterHeavy, wpLoss });
                    if (!validation.accept) continue;

                    const severity = DataMiner.calculateBlunderSeverity(c.beforeEval.wp, afterHeavy.wp, c.isWhiteMove);
                    const tension = DataMiner.calculateTension(c.preBlunderFen);
                    const onlyMove = DataMiner.detectOnlyMove(afterHeavy.line1Score, afterHeavy.line2Score, !c.isWhiteMove);
                    const motifs = DataMiner.extractTacticalMotifs(c.puzzleFen, validation.solutionSequence);

                    this._savePuzzle(c, validation, history, positions, gameId, wpLoss, { severity, tension, onlyMove, motifs });
                    extracted++;
                } catch (e) {
                    if (e.name !== 'AbortError') {
                        console.error(`[Puzzle] Candidate validation failed at ply ${c.ply}:`, e.message);
                    }
                }
            }
        });

        await Promise.all(workers);
        return extracted;
    }

    _savePuzzle(c, v, history, positions, gameId, finalWpLoss, minedData) {
        const playerColor = c.isWhiteMove ? 'black' : 'white';
        const mapMove = (m) => typeof m === 'string' ? m : (m.lan ?? m.san);
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

module.exports = { PuzzleExtractor };
