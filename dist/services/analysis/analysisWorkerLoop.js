import { ChessMath } from '../../utils/chessMath.js';
import { mapLines } from '../../utils/analysisUtils.js';
export class AnalysisWorkerLoop {
    _positions;
    _engines;
    _depth;
    _multiPv;
    _signal;
    _order;
    _onEvalReady;
    _onProgress;
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
     */
    async run() {
        const { _positions, _engines, _depth, _multiPv, _signal, _order } = this;
        const total = _positions.length;
        let nextOrderIdx = 0;
        let evaluatedCount = 0;
        const workers = _engines.map(async (engine) => {
            while (nextOrderIdx < _order.length) {
                if (_signal.aborted)
                    break;
                const posIdx = _order[nextOrderIdx++];
                const fen = _positions[posIdx];
                const isBlackTurn = fen.includes(' b ');
                try {
                    const raw = await engine.analyzePosition(fen, _depth, _signal, null, _multiPv);
                    if (_signal.aborted)
                        break;
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
                }
                catch (e) {
                    if (e.name === 'AbortError')
                        break;
                    console.error(`[WorkerLoop] Engine error at ply ${posIdx}:`, e.message);
                }
            }
        });
        await Promise.all(workers);
    }
}
