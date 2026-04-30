'use strict';

const { Chess } = require('chess.js');
const { StockfishProcess } = require('./stockfishProcess');
const { ChessMath } = require('./chessMath');
const { EvaluationEngine } = require('./Evaluationrules');
const { buildPositions } = require('./analysisUtils');
const { PuzzleStore } = require('./PuzzleStore');

// Only moves with >= this wpLoss become puzzles
const MIN_WP_LOSS_FOR_PUZZLE = 0.15;

// Labels that qualify as "interesting" mistakes
const PUZZLE_LABELS = new Set(['Error', 'Error grave']);

// How many moves deep we store the solution sequence from the PV
const SOLUTION_DEPTH = 6;

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
     * @param {Array<{history: Array, gameId: string}>} games
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

        console.log(`[Puzzle] 🔍 Iniciando extracción: ${games.length} partida(s) | Depth: ${depth}`);

        try {
            this._sf.destroy();
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
                        continue; // Skip this game
                    }
                }

                const extracted = await this._processGame(processedHistory, gameId, depth, signal);
                totalExtracted += extracted;

                console.log(`[Puzzle] ✅ Partida ${i + 1}/${games.length} completada | ${extracted} puzzle(s) extraído(s)`);
                onGameDone?.({ gameIndex: i, total: games.length, extractedCount: extracted, totalExtracted });
            }

            if (!signal.aborted) {
                console.log(`[Puzzle] 🏁 Extracción finalizada | Total puzzles: ${totalExtracted}`);
                onComplete?.({ totalExtracted });
            }

        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('[Puzzle] Error durante extracción:', e.message);
                onError?.(e);
            }
        } finally {
            this._running = false;
        }
    }

    async _processGame(history, gameId, depth, signal) {
        if (!history || history.length === 0) return 0;

        const positions = buildPositions(history);
        const evalResults = new Array(positions.length).fill(null);
        let extracted = 0;

        this._sf.newGame();

        // Analyze every position sequentially (silent mode — no WS events)
        for (let i = 0; i < positions.length; i++) {
            if (signal.aborted) break;

            const fen = positions[i];
            const isBlackTurn = fen.includes(' b ');

            try {
                // multiPv=2 so we can compare best vs played move
                const raw = await this._sf.analyzePosition(fen, depth, signal, null, 2);
                if (signal.aborted) break;

                evalResults[i] = {
                    wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, isBlackTurn),
                    bestMove: raw.bestMove,
                    pv: raw.lines?.[0]?.pv ?? '',   // principal variation string from line 1
                };
            } catch (e) {
                if (e.name === 'AbortError') break;
                evalResults[i] = { wp: 0.5, bestMove: null, pv: '' };
            }
        }

        // Scan results to identify mistakes and build puzzles
        for (let ply = 0; ply < history.length; ply++) {
            if (signal.aborted) break;

            const before = evalResults[ply];
            const after  = evalResults[ply + 1];
            if (!before || !after) continue;

            const isWhiteMove = !positions[ply].includes(' b ');
            const movePlayed  = typeof history[ply] === 'string' ? history[ply] : (history[ply].lan ?? history[ply].san);
            const isEngineBest = before.bestMove === movePlayed;

            const label = EvaluationEngine.classifyMove(before.wp, after.wp, isWhiteMove, isEngineBest);

            if (!PUZZLE_LABELS.has(label)) continue;

            const rawWpLoss = isWhiteMove ? (before.wp - after.wp) : (after.wp - before.wp);
            if (rawWpLoss < MIN_WP_LOSS_FOR_PUZZLE) continue;

            // The puzzle starts AFTER the blunder. The solver has to punish it.
            const puzzleFen = positions[ply + 1];

            // The best punishment comes from the PV calculated at the post-blunder position.
            const solutionSequence = after.pv
                ? after.pv.trim().split(' ').slice(0, SOLUTION_DEPTH).filter(Boolean)
                : (after.bestMove ? [after.bestMove] : []);

            if (solutionSequence.length === 0) continue;

            // The solver is the OPPOSITE color of who blundered.
            // If White just blundered (isWhiteMove=true), it's now Black's turn to punish.
            const playerColor = isWhiteMove ? 'black' : 'white';

            console.log(`[Puzzle] Found blunder at ply ${ply} | ${isWhiteMove ? 'White' : 'Black'} blundered '${movePlayed}' | Solver: ${playerColor} | Solution: ${solutionSequence.join(' ')}`);

            PuzzleStore.save({
                fen: puzzleFen,         // Position AFTER the blunder
                solutionSequence,       // Best response(s) from this position
                playedMove: movePlayed, // Context: the move that was blundered
                label,
                wpLoss: parseFloat(rawWpLoss.toFixed(4)),
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
