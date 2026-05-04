'use strict';

const { ChessMath } = require('./chessMath');
const { EvaluationEngine } = require('./evaluationRules');
const { OpeningService } = require('./openingService');
const { buildPositions, buildAnalysisOrder, mapLines } = require('./analysisUtils');
const { MoveClassifier } = require('./moveClassifier');
const { StockfishProcess } = require('./stockfishProcess');

class GameAnalysisCoordinator {
    constructor() {
    }

    async run(history, currentIndex, gameId, engineConfig = {}, callbacks = {}) {
        const {
            onStatus, onProgress, onMoveResult, onOpeningDetected, onComplete, onError, signal, startFen
        } = callbacks;

        const depth = engineConfig.depth ?? 18;
        const multiPv = engineConfig.multiPv ?? 1;
        const t0 = Date.now();

        const hash = engineConfig.hash ?? 128;
        const threads = engineConfig.threads ?? 1;

        // Instead of feeding all threads to a single engine (which is slow at shallow depths
        // due to Lazy SMP overhead), we spawn an independent engine per thread to process
        // multiple positions in parallel.
        const numEngines = Math.max(1, threads);
        const hashPerEngine = Math.max(16, Math.floor(hash / numEngines));

        console.log(`[Game] Starting analysis: id=${gameId} | ${history.length} moves | Depth: ${depth} | MultiPV: ${multiPv} | Parallel Engines: ${numEngines} (1 thread each) | Hash/Engine: ${hashPerEngine}MB`);

        onStatus?.(true);
        onProgress?.(0, 'Starting engines…');

        const engines = Array.from({ length: numEngines }, () => new StockfishProcess());
        
        const cleanupEngines = () => {
            engines.forEach(e => e.destroy());
        };

        try {
            await Promise.all(engines.map(e => e.init({
                ...engineConfig,
                threads: 1,
                hash: hashPerEngine,
                multiPv
            })));
            
            if (signal.aborted) {
                cleanupEngines();
                return;
            }

            engines.forEach(e => e.newGame());

            const positions = buildPositions(history, startFen);
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
            let nextOrderIdx = 0;

            const workers = engines.map(async (engine) => {
                while (nextOrderIdx < order.length) {
                    if (signal.aborted) break;

                    const posIdx = order[nextOrderIdx++];
                    const fen = positions[posIdx];
                    const isBlackTurn = fen.includes(' b ');

                    try {
                        const raw = await engine.analyzePosition(fen, depth, signal, null, multiPv);
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
            });

            await Promise.all(workers);

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
            cleanupEngines();
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