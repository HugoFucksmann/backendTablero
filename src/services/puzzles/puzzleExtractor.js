'use strict';

const { Chess } = require('chess.js');
const { StockfishProcess } = require('../../core/stockfishProcess');
const { ChessMath } = require('../../utils/chessMath');
const { EvaluationEngine } = require('../analysis/evaluationRules');
const { buildPositions } = require('../../utils/analysisUtils');
const { PuzzleStore } = require('../../storage/puzzleStore');
const { evaluatePuzzleCandidate, isTacticalMove, allowsMate } = require('./puzzleFilters');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum WP loss for a move to even be considered as a puzzle candidate. */
const MIN_WP_LOSS_FOR_PUZZLE = 0.15;

/** Only these EvaluationEngine labels feed the puzzle pipeline. */
const PUZZLE_LABELS = new Set(['Error', 'Error grave']);

// ─────────────────────────────────────────────────────────────────────────────

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
     * Processes an array of game histories sequentially.
     * Emits progress callbacks to the caller (WebSocket handler).
     *
     * @param {Array<{history: Array, pgn?: string, gameId: string}>} games
     * @param {object} engineConfig  depth, threads, hash
     * @param {object} callbacks     onGameDone, onComplete, onError
     */
    async extractFromGames(games, engineConfig = {}, callbacks = {}) {
        const { onGameDone, onComplete, onCancelled, onError } = callbacks;

        if (this._running) this.cancel();
        this._ac = new AbortController();
        const { signal } = this._ac;
        this._running = true;

        const depth = engineConfig.depth ?? 20;
        let totalExtracted = 0;

        const threads = engineConfig.threads ?? 1;
        const hash = engineConfig.hash ?? 128;

        const numEngines = Math.max(1, threads);
        const hashPerEngine = Math.max(16, Math.floor(hash / numEngines));

        console.log(`[Puzzle] Starting extraction: ${games.length} game(s) | Depth: ${depth} | Parallel Engines: ${numEngines} (1 thread each) | Hash/Engine: ${hashPerEngine}MB`);
        console.log(`[Puzzle] Strategy: Two-phase | Phase 1: Light D16/MP1 scan | Phase 2: Surgical Heavy D20+/MP2 validation`);

        const engines = Array.from({ length: numEngines }, () => new StockfishProcess());
        const cleanupEngines = () => engines.forEach(e => e.destroy());

        try {
            await Promise.all(engines.map(e => e.init({
                ...engineConfig,
                threads: 1,
                hash: hashPerEngine,
                multiPv: 1
            })));

            for (let i = 0; i < games.length; i++) {
                if (signal.aborted) break;

                const { pgn, history, gameId, startFen: providedStartFen } = games[i];
                let processedHistory = history;
                let finalStartFen = providedStartFen;

                if (!processedHistory && pgn) {
                    try {
                        const chess = new Chess();
                        chess.loadPgn(pgn);
                        processedHistory = chess.history({ verbose: true });
                        finalStartFen = finalStartFen || chess.header().FEN || null;
                    } catch (e) {
                        console.error(`[Puzzle] Error parsing PGN for game ${gameId}:`, e.message);
                        continue;
                    }
                }

                const extracted = await this._processGame(processedHistory, gameId, depth, engines, signal, finalStartFen);

                // Check abort status immediately after the game finishes — _processGame
                // may have returned early due to cancellation (extracted=0) but the loop
                // itself would still fire onGameDone without this guard.
                if (signal.aborted) break;

                totalExtracted += extracted;

                console.log(`[Puzzle] Game ${i + 1}/${games.length} done | ${extracted} puzzle(s) extracted`);
                onGameDone?.({ gameIndex: i, total: games.length, extractedCount: extracted, totalExtracted });
            }

            if (!signal.aborted) {
                console.log(`[Puzzle] Extraction finished | Total puzzles: ${totalExtracted}`);
                onComplete?.({ totalExtracted });
            } else {
                console.log(`[Puzzle] Extraction cancelled | Puzzles extracted before cancel: ${totalExtracted}`);
                onCancelled?.({ totalExtracted });
            }

        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('[Puzzle] Error during extraction:', e.message);
                onError?.(e);
            }
        } finally {
            cleanupEngines();
            this._running = false;
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    async _processGame(history, gameId, depth, engines, signal, startFen = null) {
        if (!history || history.length === 0) return 0;

        const positions = buildPositions(history, startFen);
        const lightEvalResults = new Array(positions.length).fill(null);
        let extracted = 0;

        engines.forEach(e => e.newGame());

        // ── Phase 1: Light analysis (MultiPV 1, lower depth) ───────────────
        const lightDepth = Math.min(depth, 16); 
        let nextLightIdx = 0;

        const lightWorkers = engines.map(async (engine) => {
            while (nextLightIdx < positions.length) {
                if (signal.aborted) break;
                const posIdx = nextLightIdx++;
                const fen = positions[posIdx];
                const isBlackTurn = fen.includes(' b ');

                try {
                    const raw = await engine.analyzePosition(fen, lightDepth, signal, null, 1);
                    if (signal.aborted) break;

                    lightEvalResults[posIdx] = {
                        wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, isBlackTurn),
                        bestMove: raw.bestMove,
                        mate: raw.mate ?? null,
                    };
                } catch (e) {
                    if (e.name === 'AbortError') break;
                    lightEvalResults[posIdx] = { wp: 0.5, bestMove: null, mate: null };
                }
            }
        });

        await Promise.all(lightWorkers);

        if (signal.aborted) return extracted;

        // ── Phase 2: Surgical heavy analysis on candidates ───────────────────
        const candidates = [];
        for (let ply = 0; ply < history.length; ply++) {
            const beforeLight = lightEvalResults[ply];
            const afterLight = lightEvalResults[ply + 1];
            if (!beforeLight || !afterLight) continue;

            const isWhiteMove = !positions[ply].includes(' b ');
            const movePlayed = typeof history[ply] === 'string'
                ? history[ply]
                : (history[ply].lan ?? history[ply].san);
            const isEngineBest = beforeLight.bestMove === movePlayed;

            const label = EvaluationEngine.classifyMove(beforeLight.wp, afterLight.wp, isWhiteMove, isEngineBest);
            if (!PUZZLE_LABELS.has(label)) continue;

            const rawWpLoss = isWhiteMove
                ? (beforeLight.wp - afterLight.wp)
                : (afterLight.wp - beforeLight.wp);
            if (rawWpLoss < MIN_WP_LOSS_FOR_PUZZLE) continue;

            const preBlunderFen = positions[ply];
            const puzzleFen = positions[ply + 1];

            const isPunishmentTactical = isTacticalMove(puzzleFen, afterLight.bestMove);
            const mateAllowed = allowsMate(afterLight.mate);

            if (!mateAllowed && !isPunishmentTactical) {
                console.log(`[Puzzle] Ply ${ply} rejected — punishment is not tactical (positional blunder)`);
                continue;
            }

            candidates.push({ ply, beforeLight, isWhiteMove, movePlayed, isEngineBest, puzzleFen, preBlunderFen, label });
        }

        const heavyDepth = Math.max(depth, 20);
        let nextCandidateIdx = 0;

        const heavyWorkers = engines.map(async (engine) => {
            while (nextCandidateIdx < candidates.length) {
                if (signal.aborted) break;
                const candidate = candidates[nextCandidateIdx++];
                const { ply, beforeLight, isWhiteMove, movePlayed, isEngineBest, puzzleFen, preBlunderFen, label } = candidate;

                try {
                    const raw = await engine.analyzePosition(puzzleFen, heavyDepth, signal, null, 2);
                    if (signal.aborted) break;

                    const isBlackTurnPuzzle = puzzleFen.includes(' b ');
                    const afterHeavy = {
                        wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, isBlackTurnPuzzle),
                        pv: raw.lines?.[0]?.pv ?? '',
                        mate: raw.mate ?? null,
                        line1Score: raw.lines?.[0]?.score ?? raw.score ?? 0,
                        line2Score: raw.lines?.[1]?.score ?? null,
                    };

                    const finalWpLoss = isWhiteMove
                        ? (beforeLight.wp - afterHeavy.wp)
                        : (afterHeavy.wp - beforeLight.wp);

                    if (finalWpLoss < MIN_WP_LOSS_FOR_PUZZLE) continue;

                    const result = evaluatePuzzleCandidate({
                        beforeEval: beforeLight,
                        afterEval: afterHeavy,
                        isWhiteMove,
                        isEngineBest,
                        wpLoss: finalWpLoss,
                        puzzleFen,
                        preBlunderFen,
                    });

                    if (!result.accept) {
                        console.log(`[Puzzle] Ply ${ply} rejected — ${result.reason}`);
                        continue;
                    }

                    const playerColor = isWhiteMove ? 'black' : 'white';

                    const mapMove = (m) => typeof m === 'string' ? m : (m.lan ?? m.san);
                    const startIndex = Math.max(0, ply - 2);
                    const baseFen = positions[startIndex];
                    const contextMoves = history.slice(startIndex, ply).map(mapMove);
                    const originalContinuation = history.slice(ply + 1, ply + 1 + result.solutionSequence.length).map(mapMove);

                    console.log(
                        `[Puzzle] ✓ Ply ${ply} | Type: ${result.puzzleType}` +
                        (result.mateIn ? ` (Mate in ${result.mateIn})` : '') +
                        ` | Solver: ${playerColor}` +
                        ` | Solution: ${result.solutionSequence.join(' ')}`
                    );

                    PuzzleStore.save({
                        fen: puzzleFen,
                        baseFen: baseFen,
                        contextMoves: contextMoves,
                        originalContinuation: originalContinuation,
                        preBlunderFen: preBlunderFen,
                        solutionSequence: result.solutionSequence,
                        playedMove: movePlayed,
                        label,
                        puzzleType: result.puzzleType,
                        mateIn: result.mateIn ?? null,
                        wpLoss: parseFloat(finalWpLoss.toFixed(4)),
                        preBlunderWp: parseFloat(beforeLight.wp.toFixed(4)),
                        solutionMoveCount: result.solutionSequence.length,
                        playerColor,
                        gameId,
                        ply,
                    });

                    extracted++;
                } catch (e) {
                    if (e.name === 'AbortError') break;
                    console.error(`[Puzzle] Heavy analysis failed at ply ${ply}:`, e.message);
                }
            }
        });

        await Promise.all(heavyWorkers);

        return extracted;
    }
}

module.exports = { PuzzleExtractor };
