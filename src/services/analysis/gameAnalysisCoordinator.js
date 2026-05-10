'use strict';

const { ChessMath } = require('../../utils/chessMath');
const { EvaluationEngine } = require('./evaluationRules');
const { OpeningService } = require('../openings/openingService');
const { buildPositions, buildAnalysisOrder, mapLines } = require('../../utils/analysisUtils');
const { MoveClassifier } = require('./moveClassifier');
const { PhaseDetector } = require('../../utils/phaseDetector');
const { StockfishProcess } = require('../../core/stockfishProcess');
const { GameStore } = require('../../storage/gameStore');

class GameAnalysisCoordinator {
    constructor() {
    }

    async run(history, currentIndex, gameId, engineConfig = {}, callbacks = {}, extraInfo = {}) {
        const {
            onStatus, onProgress, onMoveResult, onOpeningDetected, onComplete, onError, signal, startFen
        } = callbacks;

        const depth = engineConfig.depth ?? 18;
        const multiPv = engineConfig.multiPv ?? 1;
        const t0 = Date.now();
        let detectedOpening = 'Unknown';
        let detectedEco = '';
        const times = extraInfo.times || [];

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

            // Acumuladores por fase — se populan en _tryClassify
            // Estructura: { phase: { wpLossSum, count } }
            const phaseData = {
                'Apertura':    { wpLossSum: 0, count: 0 },
                'Medio Juego': { wpLossSum: 0, count: 0 },
                'Final':       { wpLossSum: 0, count: 0 },
            };

            // Acumulador de etiquetas: { Brillante: N, Mejor: N, ... }
            const labelCounts = {};

            const openingState = { done: false };

            const openingPromise = OpeningService.detectOpenings({
                positions, history, gameId,
                token: engineConfig.lichessToken || process.env.LICHESS_TOKEN,
                signal,
                onPlyResolved: (ply, isBook) => {
                    bookStatus[ply] = isBook;
                    this._tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult, phaseData, labelCounts, times);
                },
                onOpeningDetected: (data) => {
                    if (data?.openingName) detectedOpening = data.openingName;
                    if (data?.ecoCode) detectedEco = data.ecoCode;
                    onOpeningDetected?.(data);
                },
            });

            openingPromise
                .catch(() => { /* errors handled below */ })
                .finally(() => {
                    if (signal.aborted) return;
                    openingState.done = true;
                    for (let i = 0; i < totalMoves; i++) {
                        this._tryClassify(i, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult, phaseData, labelCounts, times);
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

                        this._tryClassify(posIdx - 1, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult, phaseData, labelCounts, times);
                        this._tryClassify(posIdx, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult, phaseData, labelCounts, times);

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

                // Convertir acumuladores de fase a porcentaje de precisión
                const PHASE_COLORS = { 'Apertura': '#4caf50', 'Medio Juego': '#ff9800', 'Final': '#2196f3' };
                const accuracyByPhase = Object.entries(phaseData)
                    .filter(([, d]) => d.count > 0)
                    .map(([phase, d]) => ({
                        phase,
                        // Precisión por fase: promedio de (1 - wpLoss) clampado a 0-100
                        accuracy: Math.round(Math.max(0, Math.min(100, (1 - d.wpLossSum / d.count) * 100))),
                        color: PHASE_COLORS[phase],
                    }));

                // Persistencia automática
                try {
                    const fullData = {
                        accuracy,
                        opening: { name: detectedOpening, eco: detectedEco },
                        history: history.map(m => m.san || m),
                        positions,
                        evaluations: evalResults,
                        moveEvaluations: Object.fromEntries(
                            Array.from(completedSet)
                                .filter(idx => finalMoveData[idx]?.label)
                                .map(idx => [idx, finalMoveData[idx].label])
                        ),
                        movePhases: Object.fromEntries(
                            Array.from(completedSet)
                                .filter(idx => finalMoveData[idx]?.phase)
                                .map(idx => [idx, finalMoveData[idx].phase])
                        ),
                        bestMoves: Object.fromEntries(
                            Array.from(completedSet)
                                .filter(idx => evalResults[idx + 1]?.bestMove)
                                .map(idx => [idx, evalResults[idx + 1].bestMove])
                        ),
                        alternativeLines: Object.fromEntries(
                            Array.from(completedSet)
                                .filter(idx => evalResults[idx + 1]?.lines)
                                .map(idx => [idx, evalResults[idx + 1].lines])
                        )
                    };

                    const movesToSave = Array.from(completedSet).map(idx => {
                        const m = finalMoveData[idx];
                        const historyMove = history[idx];
                        const san = typeof historyMove === 'string' ? historyMove : historyMove.san;
                        const evalResult = evalResults[idx + 1];
                        return {
                            ply: idx,
                            san,
                            evaluation: evalResult?.wp,
                            label: m.label,
                            moveTime: m.moveTime,
                            remainingTime: m.remainingTime,
                            fen: positions[idx]
                        };
                    });

                    await GameStore.save({
                        gameId,
                        username: extraInfo.username || null,
                        white: { accuracy: accuracy.white },
                        black: { accuracy: accuracy.black },
                        opening: detectedOpening,
                        eco: detectedEco,
                        moveCount: totalMoves,
                        date: new Date().toISOString(),
                        color: extraInfo.playerColor || 'white',
                        win: extraInfo.win ?? 1,
                        timeControl: extraInfo.timeControl || null,
                        accuracyByPhase,
                        labelCounts,
                        moves: movesToSave
                    }, fullData);

                } catch (e) {
                    console.error('[Game] Failed to save analysis:', e.message);
                }

                onComplete?.(accuracy);
                onProgress?.(100, 'Analysis completed');
            }

        } finally {
            cleanupEngines();
            onStatus?.(false);
        }
    }

    _tryClassify(ply, history, positions, evalResults, bookStatus, openingState, finalMoveData, completedSet, onMoveResult, phaseData, labelCounts, times) {
        if (completedSet.has(ply)) return;

        let moveTime = undefined;
        let remainingTime = undefined;
        if (times && times.length > ply) {
            remainingTime = times[ply];
            if (ply >= 2 && times[ply - 2] !== undefined) {
                moveTime = times[ply - 2] - times[ply];
            }
        }

        const result = MoveClassifier.classify({
            ply, history, positions, evalResults,
            bookStatus, openingDone: openingState.done,
            moveTime, remainingTime
        });

        if (result) {
            const { label, isBook, wpLoss, isWhiteMove } = result;
            onMoveResult?.({ index: ply, label, isBook });
            
            let phase = 'Medio Juego';
            if (isBook) {
                phase = 'Apertura';
            } else {
                const fen = positions[ply];
                phase = PhaseDetector.detect(ply, fen, false);
                phaseData[phase].wpLossSum += wpLoss;
                phaseData[phase].count++;
                labelCounts[label] = (labelCounts[label] ?? 0) + 1;
            }

            finalMoveData[ply] = { label, isWhiteMove, wpLoss, isBook, phase, moveTime, remainingTime };
            completedSet.add(ply);
        }
    }

}

module.exports = { GameAnalysisCoordinator };
