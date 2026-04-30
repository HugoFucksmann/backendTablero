'use strict';

const { StockfishProcess } = require('./stockfishProcess');
const { ChessMath } = require('./chessMath');
const { EvaluationEngine } = require('./Evaluationrules');
const { OpeningService } = require('./Openingservice');
const { buildPositions, buildAnalysisOrder, mapLines } = require('./analysisUtils');
const { MoveClassifier } = require('./MoveClassifier');

class AnalysisQueue {
    constructor() {
        this._sf = new StockfishProcess();
        this._ac = null;
        this.running = false;
    }

    cancel() {
        this.running = false;
        if (this._ac) {
            this._ac.abort();
            this._ac = null;
        }
        this._sf.stop();
    }

    destroy() {
        console.log('[Engine] 🗑️ Destruyendo instancia de Stockfish');
        this.cancel();
        this._sf.destroy();
    }

    async analyzePosition(fen, moveIndex, config = {}, callbacks = {}) {
        const { onProgress, onResult, onError } = callbacks;

        this.cancel();
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
                console.log(`[Live] 🎯 Posición: ${fen.split(' ')[0].slice(0, 20)}... | Depth: ${depth} | Score: ${visualScore}`);
                
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

    async analyzeGame(history, currentIndex, gameId, engineConfig = {}, callbacks = {}) {
        const {
            onStatus, onProgress, onMoveResult, onOpeningDetected, onComplete, onError,
        } = callbacks;

        this.cancel();
        if (!history || history.length === 0) return;

        this._sf.destroy();
        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        const depth = engineConfig.depth ?? 18;
        const multiPv = engineConfig.multiPv ?? 1;
        const t0 = Date.now();

        console.log(`[Game] 🚀 Iniciando análisis: id=${gameId} | ${history.length} jugadas | Depth: ${depth} | MultiPV: ${multiPv}`);

        onStatus?.(true);
        onProgress?.(0, 'Iniciando motores…');

        try {
            await this._sf.init(engineConfig);
            if (signal.aborted) return;

            this._sf.newGame();

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

            openingPromise.finally(() => {
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
                const isHighPri = posIdx === currentIndex || posIdx === currentIndex + 1;
                const d = isHighPri ? depth : Math.max(10, depth - 3);

                try {
                    const raw = await this._sf.analyzePosition(fen, d, signal, null, multiPv);
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
                    onProgress?.(Math.min(99, pct), `Analizando (${pct}%)`);

                } catch (e) {
                    if (e.name === 'AbortError') break;
                    console.error(`[AnalysisQueue] Engine error at ply ${posIdx}:`, e.message);
                }
            }

            if (!signal.aborted) {
                await openingPromise.catch(() => { });
            }

            if (!signal.aborted) {
                const accuracy = EvaluationEngine.calculateAccuracy(finalMoveData);
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.log(`[Game] ✅ Análisis completado en ${elapsed}s | Precisión: W:${accuracy.white}% B:${accuracy.black}%`);
                
                onComplete?.(accuracy);
                onProgress?.(100, 'Análisis completado');
            }

        } catch (e) {
            if (e.name !== 'AbortError') onError?.(e);
        } finally {
            onStatus?.(false);
            this.running = false;
        }
    }

    _tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult) {
        const result = MoveClassifier.classify({
            ply, history, positions, evalResults, 
            bookStatus, openingDone: openingState.done 
        });

        if (result && !completedSet.has(ply)) {
            const { index, label, isBook, wpLoss, isWhiteMove } = result;
            onMoveResult?.({ index, label, isBook });
            finalMoveData[index] = { isWhiteMove, wpLoss, isBook };
            completedSet.add(index);
        }
    }
}

module.exports = { AnalysisQueue };