'use strict';

const { EngineProcess, EngineState } = require('./engineProcess');
const { parseInfoLine, parseBestmoveLine } = require('./uciParser');

const DEFAULT_CONFIG = {
    threads: Math.max(1, require('os').cpus().length - 1),
    hash: 128,
    multiPv: 1,
    depth: 18,
};

class StockfishProcess {
    constructor() {
        this._engine = new EngineProcess();
        this._config = { ...DEFAULT_CONFIG };
        this._initPromise = null;
        this._idlePromise = Promise.resolve();
        this._idleResolve = null;
        this._engine.onDied = () => this._onEngineDied();
    }

    init(config = {}) {
        const merged = { ...this._config, ...config };

        if (this._engine.state === EngineState.IDLE) {
            const prev = this._config;
            if (JSON.stringify(merged) !== JSON.stringify(prev)) {
                if (merged.threads !== prev.threads) {
                    this._engine.send(`setoption name Threads value ${merged.threads}`);
                }
                if (merged.hash !== prev.hash) {
                    this._engine.send(`setoption name Hash value ${merged.hash}`);
                }
                this._config = merged;
            }
            return this._initPromise;
        }

        if (this._initPromise) return this._initPromise;

        this._config = merged;
        this._initPromise = this._spawnAndHandshake();
        return this._initPromise;
    }

    newGame() {
        if (this._engine.state === EngineState.IDLE) {
            this._engine.send('ucinewgame');
        }
    }

    async analyzePosition(fen, depth, signal = null, onProgress = null, multiPv = null) {
        if (!fen || typeof fen !== 'string') throw new Error('Invalid FEN');

        if (this._engine.state === EngineState.DEAD) {
            this._initPromise = null;
            await this.init(this._config);
        } else {
            await this._initPromise;
        }

        const t0 = performance.now();
        await this._idlePromise;
        const tWait = Math.round(performance.now() - t0);

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (this._engine.state !== EngineState.IDLE) {
            throw new Error(`Unexpected engine state: ${this._engine.state}`);
        }

        const effectiveMultiPv = multiPv ?? this._config.multiPv;

        return new Promise((resolve, reject) => {
            this._idlePromise = new Promise(r => { this._idleResolve = r; });
            this._engine.state = EngineState.SEARCHING;

            const lines = {};
            let lastBestMove = '';
            let settled = false;

            const settle = (err, result) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                const elapsed = Math.round(performance.now() - t0);

                if (err) reject(err);
                else resolve(result);
            };

            const onAbort = () => {
                if (this._engine.state === EngineState.SEARCHING) {
                    this._engine.state = EngineState.STOPPING;
                    this._engine.send('stop');
                }
                settle(new DOMException('Aborted', 'AbortError'), null);
            };
            signal?.addEventListener('abort', onAbort);

            const searchHandler = (line) => {
                const bm = parseBestmoveLine(line);
                if (bm !== null) {
                    lastBestMove = bm.bestMove || lastBestMove;
                    this._engine.state = EngineState.IDLE;
                    this._engine.lineHandler = null;
                    if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }

                    if (!settled) {
                        if (!lines[1]) {
                            lines[1] = { multipv: 1, score: 0, mate: null, pv: '', move: lastBestMove };
                        }
                        settle(null, {
                            score: lines[1].score,
                            mate: lines[1].mate ?? null,
                            bestMove: lastBestMove || lines[1].move,
                            pv: lines[1].pv,
                            lines: Object.values(lines).sort((a, b) => a.multipv - b.multipv),
                        });
                    }
                    return;
                }

                if (this._engine.state === EngineState.STOPPING) return;

                const info = parseInfoLine(line);
                if (info !== null) {
                    const { multipv: idx, depth: d, score, mate, pv, move } = info;
                    if (!lines[idx]) lines[idx] = { multipv: idx, score: 0, mate: null, pv: '', move: '', depth: 0 };

                    lines[idx].depth = d;
                    lines[idx].score = score;
                    lines[idx].mate = mate;
                    lines[idx].pv = pv;
                    lines[idx].move = move;

                    if (onProgress) {
                        onProgress({
                            depth: lines[1]?.depth ?? 0,
                            score: lines[1]?.score ?? 0,
                            mate: lines[1]?.mate ?? null,
                            bestMove: lines[1]?.move ?? '',
                            lines: Object.values(lines).sort((a, b) => a.multipv - b.multipv),
                        });
                    }
                }
            };

            this._engine.lineHandler = (line) => {
                if (line === 'readyok') {
                    if (signal?.aborted || this._engine.state === EngineState.STOPPING) {
                        this._engine.state = EngineState.IDLE;
                        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
                        settle(new DOMException('Aborted', 'AbortError'), null);
                        return;
                    }
                    this._engine.send(`position fen ${fen}`);
                    this._engine.send(`go depth ${depth}`);
                    this._engine.lineHandler = searchHandler;
                }
            };

            this._engine.send(`setoption name MultiPV value ${effectiveMultiPv}`);
            this._engine.send('isready');
        });
    }

    async stopAndWait() {
        if (this._engine.state === EngineState.SEARCHING) {
            this._engine.state = EngineState.STOPPING;
            this._engine.send('stop');
        }
        await this._idlePromise;
    }

    stop() {
        if (this._engine.state === EngineState.SEARCHING) {
            this._engine.state = EngineState.STOPPING;
            this._engine.send('stop');
        }
    }

    destroy() {
        this._initPromise = null;
        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
        this._idlePromise = Promise.resolve();
        this._engine.kill();
    }

    async _spawnAndHandshake() {
        await this._engine.spawn();

        return new Promise((resolve, reject) => {
            const prevOnDied = this._engine.onDied;
            this._engine.onDied = () => {
                this._onEngineDied();
                reject(new Error('Engine died during UCI handshake'));
            };

            this._engine.lineHandler = (line) => {
                if (line === 'uciok') {
                    this._engine.send(`setoption name Threads value ${this._config.threads}`);
                    this._engine.send(`setoption name Hash value ${this._config.hash}`);
                    this._engine.send(`setoption name MultiPV value ${this._config.multiPv}`);
                    this._engine.send('isready');
                }
                if (line === 'readyok') {
                    this._engine.state = EngineState.IDLE;
                    this._engine.lineHandler = null;
                    this._engine.onDied = prevOnDied;
                    resolve();
                }
            };

            this._engine.send('uci');
        });
    }

    _onEngineDied() {
        this._initPromise = null;
        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
        this._idlePromise = Promise.resolve();
        this._engine.onDied = () => this._onEngineDied();
    }
}

module.exports = { StockfishProcess, DEFAULT_CONFIG };