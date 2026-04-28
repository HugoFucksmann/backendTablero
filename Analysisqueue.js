'use strict';

/**
 * AnalysisQueue (server-side)
 * ───────────────────────────
 * Mirror of the browser analysisQueue.js.
 *
 * One instance is created per WebSocket client so each client has its own
 * Stockfish process and independent abort controller.
 *
 * The two public methods match the browser API:
 *   analyzeGame(history, currentIndex, gameId, engineConfig, callbacks)
 *   analyzePosition(fen, moveIndex, config, callbacks)
 */

const { Chess } = require('chess.js');
const { StockfishProcess } = require('./stockfishProcess');
const { ChessMath } = require('./chessMath');
const { EvaluationEngine } = require('./Evaluationrules.js');
const { OpeningService, MAX_BOOK_PLY } = require('./Openingservice.js');

class AnalysisQueue {
    /**
     * @param {import('./PositionCache').PositionCache} cache
     */
    constructor(cache) {
        this._cache = cache;
        this._sf = new StockfishProcess();
        this._ac = null;   // AbortController
        this.running = false;
    }

    // ── Cancel ───────────────────────────────────────────────────────────────

    cancel() {
        this.running = false;
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

    // ── Live position (single FEN) ────────────────────────────────────────────

    async analyzePosition(fen, moveIndex, config = {}, callbacks = {}) {
        const { onProgress, onResult, onError } = callbacks;

        this.cancel();
        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        const depth = config.depth ?? 18;
        const multiPv = config.multiPv ?? 3;

        // Cache hit?
        const cached = this._cache.getPosition(fen, depth, multiPv);
        if (cached) {
            onResult?.({ ...cached, moveIndex });
            this.running = false;
            return;
        }

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
                        lines: _mapLines(lines, isBlackTurn),
                    });
                },
                multiPv,
            );

            if (!signal.aborted) {
                const final = {
                    score: ChessMath.cpToVisualScore(result.score, result.mate, isBlackTurn),
                    mate: result.mate,
                    bestMove: result.bestMove,
                    moveIndex,
                    lines: _mapLines(result.lines, isBlackTurn),
                };
                this._cache.setPosition(fen, depth, multiPv, final);
                onResult?.(final);
            }
        } catch (e) {
            if (e.name !== 'AbortError') onError?.(e);
        } finally {
            this.running = false;
        }
    }

    // ── Full game analysis ────────────────────────────────────────────────────

    async analyzeGame(history, currentIndex, gameId, engineConfig = {}, callbacks = {}) {
        const {
            onStatus, onProgress, onMoveResult, onOpeningDetected, onComplete, onError,
        } = callbacks;

        this.cancel();
        if (!history || history.length === 0) return;

        this._sf.destroy(); // fresh engine per game
        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        onStatus?.(true);
        onProgress?.(0, 'Iniciando motores…');

        try {
            await this._sf.init(engineConfig);
            if (signal.aborted) return;

            this._sf.newGame();

            const positions = _buildPositions(history);
            const totalMoves = history.length;

            const evalResults = new Array(positions.length).fill(null);
            const bookStatus = new Array(totalMoves).fill(null);
            const completedSet = new Set();
            const finalMoveData = new Array(totalMoves);
            let evaluatedCount = 0;

            const openingState = { done: false };

            // ── Opening detection (parallel) ──────────────────────────────
            const openingPromise = OpeningService.detectOpenings({
                positions, history, gameId,
                token: engineConfig.lichessToken,
                signal,
                cache: this._cache,
                onPlyResolved: (ply, isBook) => {
                    bookStatus[ply] = isBook;
                    this._tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult);
                },
                onOpeningDetected,
            });

            openingPromise.finally(() => {
                if (signal.aborted) return;
                openingState.done = true;
                for (let i = 0; i < totalMoves; i++) {
                    this._tryClassify(i, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult);
                }
            });

            // ── Engine analysis (sequential, smart order) ─────────────────
            const order = _buildAnalysisOrder(positions.length, currentIndex);
            const depth = engineConfig.depth ?? 18;
            const multiPv = engineConfig.multiPv ?? 1;

            for (const posIdx of order) {
                if (signal.aborted) break;

                const fen = positions[posIdx];
                const isBlackTurn = fen.includes(' b ');
                const isHighPri = posIdx === currentIndex || posIdx === currentIndex + 1;
                const d = isHighPri ? depth : Math.max(10, depth - 3);
                const mpv = multiPv;

                // Cache hit for this position?
                let evalResult = this._cache.getPosition(fen, d, mpv);

                if (!evalResult) {
                    try {
                        const raw = await this._sf.analyzePosition(fen, d, signal, null, mpv);
                        if (signal.aborted) break;

                        evalResult = {
                            wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, isBlackTurn),
                            score: ChessMath.cpToVisualScore(raw.score, raw.mate, isBlackTurn),
                            mate: raw.mate,
                            bestMove: raw.bestMove,
                            lines: _mapLines(raw.lines, isBlackTurn),
                        };
                        this._cache.setPosition(fen, d, mpv, evalResult);

                    } catch (e) {
                        if (e.name === 'AbortError') break;
                        evalResult = { wp: 0.5, score: 0.0, mate: null, bestMove: null, lines: [] };
                    }
                }

                evalResults[posIdx] = evalResult;
                evaluatedCount++;

                // Emit score for this position
                onMoveResult?.({
                    index: posIdx === 0 ? -1 : posIdx - 1,
                    score: evalResult.score,
                    mate: evalResult.mate,
                    bestMove: evalResult.bestMove,
                    lines: evalResult.lines,
                });

                this._tryClassify(posIdx - 1, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult);
                this._tryClassify(posIdx, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult);

                const pct = Math.round((evaluatedCount / totalMoves) * 100);
                onProgress?.(Math.min(99, pct), `Analizando (${pct}%)`);
            }

            if (!signal.aborted) {
                await openingPromise.catch(() => { /* opening errors are non-fatal */ });
            }

            if (!signal.aborted) {
                onComplete?.(EvaluationEngine.calculateAccuracy(finalMoveData));
                onProgress?.(100, 'Análisis completado');
            }

        } catch (e) {
            if (e.name !== 'AbortError') onError?.(e);
        } finally {
            onStatus?.(false);
            this.running = false;
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    _tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult) {
        if (ply < 0 || ply >= history.length || completedSet.has(ply)) return;

        const before = evalResults[ply];
        const after = evalResults[ply + 1];
        if (!before || !after) return;

        const openingResolved = bookStatus[ply] !== null || openingState.done || ply >= MAX_BOOK_PLY;
        if (!openingResolved) return;

        const isWhiteMove = !positions[ply].includes(' b ');
        const movePlayed = history[ply];
        const isEngineBest = before.bestMove === movePlayed.lan;
        const isBook = bookStatus[ply] === true;

        const label = isBook
            ? 'Libro'
            : EvaluationEngine.classifyMove(before.wp, after.wp, isWhiteMove, isEngineBest);

        onMoveResult?.({ index: ply, label, isBook });

        let wpLoss = isWhiteMove ? (before.wp - after.wp) : (after.wp - before.wp);
        if (isEngineBest || wpLoss < 0) wpLoss = 0;

        finalMoveData[ply] = { isWhiteMove, wpLoss, isBook };
        completedSet.add(ply);
    }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _buildPositions(history) {
    const positions = [];
    const game = new Chess();
    positions.push(game.fen());
    for (const m of history) {
        // Accept either a move object with .lan/.san or a plain string
        game.move(typeof m === 'string' ? m : (m.san ?? m.lan ?? m));
        positions.push(game.fen());
    }
    return positions;
}

function _buildAnalysisOrder(total, currentIndex) {
    const order = [];
    const seen = new Set();
    const add = (i) => { if (i >= 0 && i < total && !seen.has(i)) { order.push(i); seen.add(i); } };

    if (currentIndex >= 0 && currentIndex < total - 1) { add(currentIndex); add(currentIndex + 1); }
    if (currentIndex > 0) add(currentIndex - 1);
    for (let i = 0; i < total; i++) add(i);
    return order;
}

function _mapLines(lines, isBlackTurn) {
    if (!Array.isArray(lines)) return [];
    return lines.map(l => ({
        ...l,
        score: ChessMath.cpToVisualScore(l.score, l.mate ?? null, isBlackTurn),
    }));
}

module.exports = { AnalysisQueue };