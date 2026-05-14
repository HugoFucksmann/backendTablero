'use strict';

const { ChessMath } = require('../../utils/chessMath');
const { mapLines } = require('../../utils/analysisUtils');

/**
 * AnalysisWorkerLoop
 * ──────────────────
 * Responsabilidad única: distribuir posiciones entre los engines disponibles
 * y emitir resultados de evaluación a medida que se completan.
 *
 * No clasifica jugadas, no calcula métricas, no persiste nada.
 */
class AnalysisWorkerLoop {
    /**
     * @param {string[]}  positions    - Array de FENs (positions[0] = pos. inicial).
     * @param {Object[]}  engines      - Instancias de StockfishProcess.
     * @param {number}    depth        - Profundidad de análisis.
     * @param {number}    multiPv      - Número de líneas PV.
     * @param {AbortSignal} signal     - Señal de cancelación.
     * @param {number[]}  order        - Índices de posición en orden de prioridad.
     * @param {Function}  onEvalReady  - Callback(posIdx, evalResult) por cada posición evaluada.
     * @param {Function}  onProgress   - Callback(evaluated, total) para progreso global.
     */
    constructor({ positions, engines, depth, multiPv, signal, order, onEvalReady, onProgress }) {
        this._positions = positions;
        this._engines = engines;
        this._depth = depth;
        this._multiPv = multiPv;
        this._signal = signal;
        this._order = order;
        this._onEvalReady = onEvalReady;
        this._onProgress = onProgress;
    }

    /**
     * Lanza todos los workers en paralelo y espera a que terminen.
     * @returns {Object[]} evalResults — array indexado por posición con {wp, score, mate, bestMove, lines}.
     */
    async run() {
        const { _positions, _engines, _depth, _multiPv, _signal, _order } = this;
        const total = _positions.length;

        let nextOrderIdx = 0;
        let evaluatedCount = 0;

        const workers = _engines.map(async (engine) => {
            while (nextOrderIdx < _order.length) {
                if (_signal.aborted) break;

                const posIdx = _order[nextOrderIdx++];
                const fen = _positions[posIdx];
                const isBlackTurn = fen.includes(' b ');

                try {
                    const raw = await engine.analyzePosition(fen, _depth, _signal, null, _multiPv);
                    if (_signal.aborted) break;

                    const evalResult = {
                        wp: ChessMath.cpToWhiteWinProb(raw.score, raw.mate, isBlackTurn),
                        score: ChessMath.cpToVisualScore(raw.score, raw.mate, isBlackTurn),
                        mate: raw.mate,
                        bestMove: raw.bestMove,
                        lines: mapLines(raw.lines, isBlackTurn),
                    };

                    evaluatedCount++;

                    this._onEvalReady?.(posIdx, evalResult);
                    this._onProgress?.(evaluatedCount, total); 

                } catch (e) {
                    if (e.name === 'AbortError') break;
                    console.error(`[WorkerLoop] Engine error at ply ${posIdx}:`, e.message);
                }
            }
        });

        await Promise.all(workers);
    }
}

module.exports = { AnalysisWorkerLoop };