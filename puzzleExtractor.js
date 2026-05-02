'use strict';

const { Chess } = require('chess.js');
const { StockfishProcess } = require('./stockfishProcess');
const { ChessMath } = require('./chessMath');
const { EvaluationEngine } = require('./evaluationRules');
const { buildPositions } = require('./analysisUtils');
const { PuzzleStore } = require('./puzzleStore');
const { evaluatePuzzleCandidate } = require('./puzzleFilters');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum WP loss for a move to even be considered as a puzzle candidate. */
const MIN_WP_LOSS_FOR_PUZZLE = 0.15;

/** Only these EvaluationEngine labels feed the puzzle pipeline. */
const PUZZLE_LABELS = new Set(['Error', 'Error grave']);

// ─────────────────────────────────────────────────────────────────────────────

class PuzzleExtractor {
    constructor() {
        this._sf = new StockfishProcess();
        this._running = false;
        this._ac = null;
    }

    cancel() {
        this._running = false;
        if (this._ac) {
            this._ac.abort();
            this._ac = null;
        }
        this._sf.stop();
    }

    destroy() {
        this.cancel();
        this._sf.destroy();
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
        const { onGameDone, onComplete, onError } = callbacks;

        if (this._running) this.cancel();
        this._ac = new AbortController();
        const { signal } = this._ac;
        this._running = true;

        const depth = engineConfig.depth ?? 20;
        let totalExtracted = 0;

        console.log(`[Puzzle] Starting extraction: ${games.length} game(s) | Depth: ${depth}`);

        try {
            this._sf.destroy();
            // multiPv=2 is mandatory — the gap between lines 1 and 2 is how we
            // detect whether a puzzle has a clear, unambiguous solution.
            await this._sf.init({ ...engineConfig, depth, multiPv: 2 });

            for (let i = 0; i < games.length; i++) {
                if (signal.aborted) break;

                const { pgn, history, gameId } = games[i];
                let processedHistory = history;

                if (!processedHistory && pgn) {
                    try {
                        const chess = new Chess();
                        chess.loadPgn(pgn);
                        processedHistory = chess.history({ verbose: true });
                    } catch (e) {
                        console.error(`[Puzzle] Error parsing PGN for game ${gameId}:`, e.message);
                        continue;
                    }
                }

                const extracted = await this._processGame(processedHistory, gameId, depth, signal);
                totalExtracted += extracted;

                console.log(`[Puzzle] Game ${i + 1}/${games.length} done | ${extracted} puzzle(s) extracted`);
                onGameDone?.({ gameIndex: i, total: games.length, extractedCount: extracted, totalExtracted });
            }

            if (!signal.aborted) {
                console.log(`[Puzzle] Extraction finished | Total puzzles: ${totalExtracted}`);
                onComplete?.({ totalExtracted });
            }

        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('[Puzzle] Error during extraction:', e.message);
                onError?.(e);
            }
        } finally {
            this._running = false;
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    async _processGame(history, gameId, depth, signal) {
        if (!history || history.length === 0) return 0;

        const positions = buildPositions(history);
        const evalResults = new Array(positions.length).fill(null);
        let extracted = 0;

        this._sf.newGame();

        // ── Phase 1: analyze every position ──────────────────────────────────
        for (let i = 0; i < positions.length; i++) {
            if (signal.aborted) break;

            const fen = positions[i];
            const isBlackTurn = fen.includes(' b ');

            try {
                const raw = await this._sf.analyzePosition(fen, depth, signal, null, 2);
                if (signal.aborted) break;

                // Store everything the filter layer will need.
                evalResults[i] = {
                    // Win probability (White perspective, 0..1)
                    wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, isBlackTurn),
                    // Engine's best move and full PV from this position
                    bestMove: raw.bestMove,
                    pv: raw.lines?.[0]?.pv ?? '',
                    // Raw mate value: positive = side-to-move has forced mate
                    mate: raw.mate ?? null,
                    // Raw centipawn scores for both lines (needed for gap / ambiguity check)
                    line1Score: raw.lines?.[0]?.score ?? raw.score ?? 0,
                    line2Score: raw.lines?.[1]?.score ?? null,
                };
            } catch (e) {
                if (e.name === 'AbortError') break;
                // Neutral fallback so we don't crash the whole game
                evalResults[i] = { wp: 0.5, bestMove: null, pv: '', mate: null, line1Score: 0, line2Score: null };
            }
        }

        // ── Phase 2: scan for tactical mistakes ───────────────────────────────
        for (let ply = 0; ply < history.length; ply++) {
            if (signal.aborted) break;

            const before = evalResults[ply];
            const after = evalResults[ply + 1];
            if (!before || !after) continue;

            const isWhiteMove = !positions[ply].includes(' b ');
            const movePlayed = typeof history[ply] === 'string'
                ? history[ply]
                : (history[ply].lan ?? history[ply].san);
            const isEngineBest = before.bestMove === movePlayed;

            // Fast pre-filter: only process moves the engine flagged as mistakes
            const label = EvaluationEngine.classifyMove(before.wp, after.wp, isWhiteMove, isEngineBest);
            if (!PUZZLE_LABELS.has(label)) continue;

            const rawWpLoss = isWhiteMove
                ? (before.wp - after.wp)
                : (after.wp - before.wp);
            if (rawWpLoss < MIN_WP_LOSS_FOR_PUZZLE) continue;

            // FEN positions for the filter layer
            const preBlunderFen = positions[ply];       // position WHERE the blunder happened
            const puzzleFen = positions[ply + 1];   // position AFTER the blunder (puzzle start)

            // ── Delegate all quality decisions to puzzleFilters ───────────────
            const result = evaluatePuzzleCandidate({
                beforeEval: before,
                afterEval: after,
                isWhiteMove,
                isEngineBest,
                wpLoss: rawWpLoss,
                puzzleFen,
                preBlunderFen,
            });

            if (!result.accept) {
                console.log(`[Puzzle] Ply ${ply} rejected — ${result.reason}`);
                continue;
            }

            // The solver is the side OPPOSITE to who blundered
            const playerColor = isWhiteMove ? 'black' : 'white';

            console.log(
                `[Puzzle] ✓ Ply ${ply} | Type: ${result.puzzleType}` +
                (result.mateIn ? ` (Mate in ${result.mateIn})` : '') +
                ` | Solver: ${playerColor}` +
                ` | Solution: ${result.solutionSequence.join(' ')}`
            );

            PuzzleStore.save({
                // Board state
                fen: puzzleFen,
                // What the solver must play
                solutionSequence: result.solutionSequence,
                // Context: the move that created this puzzle
                playedMove: movePlayed,
                // Classification
                label,
                puzzleType: result.puzzleType,          // 'missed_mate' | 'tactical_blunder'
                mateIn: result.mateIn ?? null,
                // Quantitative metadata
                wpLoss: parseFloat(rawWpLoss.toFixed(4)),
                preBlunderWp: parseFloat(before.wp.toFixed(4)),
                solutionMoveCount: result.solutionSequence.length,
                // Game context
                playerColor,
                gameId,
                ply,
            });

            extracted++;
        }

        return extracted;
    }
}

module.exports = { PuzzleExtractor };