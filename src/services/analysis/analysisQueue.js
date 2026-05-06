'use strict';

const { StockfishProcess } = require('../../core/stockfishProcess');
const { ChessMath } = require('../../utils/chessMath');
const { mapLines } = require('../../utils/analysisUtils');
const { GameAnalysisCoordinator } = require('./gameAnalysisCoordinator');

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
}

module.exports = { AnalysisQueue };
