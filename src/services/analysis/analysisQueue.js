'use strict';

const { StockfishProcess } = require('../../core/stockfishProcess');
const { ChessMath } = require('../../utils/chessMath');
const { mapLines, parsePgn } = require('../../utils/analysisUtils');
const { GameAnalysisCoordinator } = require('./gameAnalysisCoordinator');
const { EnginePool } = require('./enginePool');

/**
 * AnalysisQueue
 * ─────────────
 * Responsibility: Manages the engine lifecycle for a single client session.
 * Dispatches between live position analysis and full game analysis.
 */
class AnalysisQueue {
    constructor() {
        this._sf = new StockfishProcess();
        this._ac = null;
        this._gameCoordinator = new GameAnalysisCoordinator();
    }

    cancel() {
        this.running = false;
        if (this._ac) {
            console.log('[Engine] Cancelling current analysis');
            this._ac.abort();
            this._ac = null;
        }
        this._sf.stop();
    }

    destroy() {
        console.log('[Engine] Destroying session Stockfish instance');
        this.cancel();
        this._sf.destroy();
    }

    /**
     * Analyzes a single position (Live mode).
     */
    async analyzePosition(fen, moveIndex, config = {}, callbacks = {}) {
        const { onProgress, onResult, onError } = callbacks;

        this.cancel();
        // If the engine was mid-initialization, wait for it to settle before
        // proceeding. This prevents the new analyzePosition from racing with
        // a concurrent _spawnAndHandshake that cancel() couldn't interrupt.
        try { await this._sf._initPromise; } catch { /* ignore — we'll re-init below */ }

        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        const depth = config.depth ?? 18;
        const multiPv = config.multiPv ?? 3;

        try {
            await this._sf.init(config);
            if (signal.aborted) return;

            const isBlackTurn = fen.includes(' b ');

            const result = await this._sf.analyzePosition(
                fen, depth, signal,
                ({ score, mate, bestMove, lines }) => {
                    onProgress?.({
                        score: ChessMath.cpToVisualScore(score, mate, isBlackTurn),
                        mate,
                        bestMove,
                        moveIndex,
                        lines: mapLines(lines, isBlackTurn),
                    });
                },
                multiPv,
            );

            if (!signal.aborted) {
                const visualScore = ChessMath.cpToVisualScore(result.score, result.mate, isBlackTurn);
                console.log(`[Live] Position analyzed | Score: ${visualScore}`);

                onResult?.({
                    score: visualScore,
                    mate: result.mate,
                    bestMove: result.bestMove,
                    moveIndex,
                    lines: mapLines(result.lines, isBlackTurn),
                });
            }
        } catch (e) {
            if (e.name !== 'AbortError') onError?.(e);
        } finally {
            this.running = false;
        }
    }

    /**
     * Analyzes a full game history.
     */
    async analyzeGame(history, currentIndex, gameId, engineConfig = {}, callbacks = {}, startFen = null, extraInfo = {}) {
        this.cancel();
        if (!history || history.length === 0) return;

        // Rebuild the coordinator to ensure a clean slate.
        // We do not destroy the live engine (this._sf) to maintain independence.
        this._gameCoordinator = new GameAnalysisCoordinator();

        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        try {
            await this._gameCoordinator.run(history, currentIndex, gameId, engineConfig, {
                ...callbacks,
                signal,
                startFen
            }, extraInfo);
            // GameAnalysisCoordinator exits cleanly on abort without throwing,
            // so we must check the signal here to distinguish cancel from complete.
            if (signal.aborted) {
                console.log('[Game] Analysis cancelled — notifying client');
                callbacks.onCancelled?.();
            }
        } catch (e) {
            if (e.name !== 'AbortError') callbacks.onError?.(e);
            else {
                console.log('[Game] Analysis cancelled (AbortError) — notifying client');
                callbacks.onCancelled?.();
            }
        } finally {
            this.running = false;
        }
    }

    /**
     * Analyzes multiple games sequentially.
     */
    async analyzeGames(games, engineConfig = {}, callbacks = {}) {
        const { onGameStarted, onGameProgress, onGameComplete, onBatchComplete, onCancelled, onError } = callbacks;

        this.cancel();
        if (!Array.isArray(games) || games.length === 0) return;

        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        console.log(`[Batch] Starting batch analysis of ${games.length} games`);

        // ── Pre-spawnear pool de engines UNA SOLA VEZ ────────────────────────────
        // Evita el overhead de spawn+handshake+destroy por cada partida.
        const pool = new EnginePool(engineConfig);

        try {
            await pool.init();
            const batchEngines = pool.engines;
            console.log(`[Batch] Engine pool ready: ${pool.count} engine(s)`);

            for (let i = 0; i < games.length; i++) {
                if (signal.aborted) break;

                // Enviar 'ucinewgame' a todos los motores para purgar Hash y heurísticas.
                // Previene "cuelgues" eternos en finales por saturación en partidas largas o iteradas.
                batchEngines.forEach(e => e.newGame());

                const game = games[i];
                const { history, gameId, pgn, startFen, playerColor, win, timeControl, opponent, gameDate } = game;

                let actualHistory = history;
                let actualStartFen = startFen;

                if (!actualHistory && pgn) {
                    const parsed = parsePgn(pgn);
                    actualHistory = parsed.history;
                    actualStartFen = parsed.startFen;
                    game.times = parsed.times;
                    // Extract player names from PGN headers so they're persisted in fullData.players
                    if (!game.playerWhite && parsed.headers?.White) game.playerWhite = parsed.headers.White;
                    if (!game.playerBlack && parsed.headers?.Black) game.playerBlack = parsed.headers.Black;
                }

                if (!actualHistory || actualHistory.length === 0) {
                    console.warn(`[Batch] Game ${i} has no history/PGN, skipping.`);
                    continue;
                }

                onGameStarted?.({ gameIndex: i, total: games.length, gameId });

                this._gameCoordinator = new GameAnalysisCoordinator();

                await this._gameCoordinator.run(
                    actualHistory, 0, gameId, engineConfig,
                    {
                        onProgress: (pct, label) => onGameProgress?.({ gameIndex: i, pct, label }),
                        onMoveResult: (data) => callbacks.onMoveResult?.({ gameIndex: i, ...data }),
                        onOpeningDetected: (data) => callbacks.onOpeningDetected?.({ gameIndex: i, ...data }),
                        onComplete: (accuracy) => onGameComplete?.({ gameIndex: i, accuracy }),
                        signal,
                        startFen: actualStartFen
                    },
                    { playerColor, win, timeControl, times: game.times, username: game.username,
                      playerWhite: game.playerWhite || null, playerBlack: game.playerBlack || null,
                      opponent: opponent || game.opponent || null,
                      gameDate: gameDate || game.gameDate || null },
                    batchEngines   // ← reutiliza el pool sin re-spawnear
                );

                if (signal.aborted) break;
            }

            if (signal.aborted) {
                onCancelled?.();
            } else {
                onBatchComplete?.({ total: games.length });
            }
        } catch (e) {
            if (e.name !== 'AbortError') onError?.(e);
            else onCancelled?.();
        } finally {
            // Destruir el pool al terminar el lote (o en caso de error/cancelación)
            pool.destroy();
            console.log('[Batch] Engine pool destroyed');
            this.running = false;
        }
    }
}

module.exports = { AnalysisQueue };
