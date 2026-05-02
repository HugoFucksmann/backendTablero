'use strict';

const { ChessMath } = require('./chessMath');
const { EvaluationEngine } = require('./evaluationRules');
const { OpeningService } = require('./openingService');
const { buildPositions, buildAnalysisOrder, mapLines } = require('./analysisUtils');
const { MoveClassifier } = require('./moveClassifier');

class GameAnalysisCoordinator {
    constructor(engine) {
        this._engine = engine;
    }

    async run(history, currentIndex, gameId, engineConfig = {}, callbacks = {}) {
        const {
            onStatus, onProgress, onMoveResult, onOpeningDetected, onComplete, onError, signal
        } = callbacks;

        const depth = engineConfig.depth ?? 18;
        const multiPv = engineConfig.multiPv ?? 1;
        const t0 = Date.now();

        console.log(`[Game] Starting analysis: id=${gameId} | ${history.length} moves | Depth: ${depth} | MultiPV: ${multiPv}`);

        onStatus?.(true);
        onProgress?.(0, 'Starting engines…');

        try {
            await this._engine.init(engineConfig);
            if (signal.aborted) return;

            this._engine.newGame();

            const positions = buildPositions(history);
            const totalMoves = history.length;

            const evalResults = new Array(positions.length).fill(null);
            const bookStatus = new Array(totalMoves).fill(null);
            const completedSet = new Set();
            const finalMoveData = new Array(totalMoves);
            let evaluatedCount = 0;

            const openingState = { done: false };

            const openingPromise = OpeningService.detectOpenings({
                positions, history, gameId,
                token: engineConfig.lichessToken || process.env.LICHESS_TOKEN,
                signal,
                onPlyResolved: (ply, isBook) => {
                    bookStatus[ply] = isBook;
                    this._tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult);
                },
                onOpeningDetected,
            });

            openingPromise
                .catch(() => { /* errors handled below */ })
                .finally(() => {
                    if (signal.aborted) return;
                    openingState.done = true;
                    for (let i = 0; i < totalMoves; i++) {
                        this._tryClassify(i, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult);
                    }
                });

            const order = buildAnalysisOrder(positions.length, currentIndex);

            for (const posIdx of order) {
                if (signal.aborted) break;

                const fen = positions[posIdx];
                const isBlackTurn = fen.includes(' b ');
                const d = depth; // User-configured depth is respected for all plies

                try {
                    const raw = await this._engine.analyzePosition(fen, d, signal, null, multiPv);
                    if (signal.aborted) break;

                    const evalResult = {
                        wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, isBlackTurn),
                        score: ChessMath.cpToVisualScore(raw.score, raw.mate, isBlackTurn),
                        mate: raw.mate,
                        bestMove: raw.bestMove,
                        lines: mapLines(raw.lines, isBlackTurn),
                    };

                    evalResults[posIdx] = evalResult;
                    evaluatedCount++;

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
                    onProgress?.(Math.min(99, pct), `Analyzing (${pct}%)`);

                } catch (e) {
                    if (e.name === 'AbortError') break;
                    console.error(`[Game] Engine error at ply ${posIdx}:`, e.message);
                }
            }

            if (!signal.aborted) {
                await openingPromise.catch(() => { });
            }

            if (signal.aborted) {
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.log(`[Game] Analysis cancelled after ${elapsed}s | id=${gameId}`);
            } else {
                const accuracy = EvaluationEngine.calculateAccuracy(finalMoveData);
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.log(`[Game] Analysis completed in ${elapsed}s | Accuracy: W:${accuracy.white}% B:${accuracy.black}%`);

                onComplete?.(accuracy);
                onProgress?.(100, 'Analysis completed');
            }

        } finally {
            onStatus?.(false);
        }
    }

    _tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult) {
        if (completedSet.has(ply)) return;

        const result = MoveClassifier.classify({
            ply, history, positions, evalResults,
            bookStatus, openingDone: openingState.done
        });

        if (result) {
            const { label, isBook, wpLoss, isWhiteMove } = result;
            onMoveResult?.({ index: ply, label, isBook });
            finalMoveData[ply] = { isWhiteMove, wpLoss, isBook };
            completedSet.add(ply);
        }
    }
}

module.exports = { GameAnalysisCoordinator };