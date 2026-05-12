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
        // Tracks the MultiPV value last sent to the engine process.
        // Avoids redundant setoption+isready round-trips between positions.
        this._activeMultiPv = DEFAULT_CONFIG.multiPv;
        this._engine.onDied = () => this._onEngineDied();
    }

    async init(config = {}) {
        const merged = { ...this._config, ...config };

        if (this._engine.state === EngineState.IDLE) {
            const prev = this._config;
            if (JSON.stringify(merged) !== JSON.stringify(prev)) {
                if (merged.threads !== prev.threads) {
                    console.log(`[Engine] Updating Threads: ${prev.threads} -> ${merged.threads}`);
                    this._engine.send(`setoption name Threads value ${merged.threads}`);
                }
                if (merged.hash !== prev.hash) {
                    console.log(`[Engine] Updating Hash: ${prev.hash}MB -> ${merged.hash}MB`);
                    this._engine.send(`setoption name Hash value ${merged.hash}`);
                }
                if (merged.multiPv !== prev.multiPv) {
                    console.log(`[Engine] Updating MultiPV: ${prev.multiPv} -> ${merged.multiPv}`);
                    this._engine.send(`setoption name MultiPV value ${merged.multiPv}`);
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
        // Basic UCI injection prevention: no newlines, only standard FEN characters
        if (!/^[rnbqkpRNBQKP1-8\/\s\-wbea-h0-9]+$/.test(fen)) {
            throw new Error('Malformed FEN string');
        }


        if (this._engine.state === EngineState.DEAD) {
            this._initPromise = null;
            await this.init(this._config);
        } else {
            await this._initPromise;
        }

        await this._idlePromise;

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (this._engine.state !== EngineState.IDLE) {
            throw new Error(`Unexpected engine state: ${this._engine.state}`);
        }

        const effectiveMultiPv = multiPv ?? this._config.multiPv;

        return new Promise((resolve, reject) => {
            this._idlePromise = new Promise(r => { this._idleResolve = r; });
            this._engine.state = EngineState.SEARCHING;

            const lines = {};
            let settled = false;

            const settle = (err, result) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);

                if (err) reject(err);
                else resolve(result);
            };

            // Register a one-time engine-death handler scoped to this analysis call.
            // If the engine dies mid-search, we must reject this promise so the caller
            // doesn't hang forever waiting for a bestmove that will never arrive.
            const prevOnDied = this._engine.onDied;
            const restoreOnDied = () => { this._engine.onDied = prevOnDied; };
            this._engine.onDied = () => {
                restoreOnDied();
                this._onEngineDied();
                settle(new Error('Engine died during analysis'), null);
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
                    this._engine.state = EngineState.IDLE;
                    this._engine.lineHandler = null;
                    restoreOnDied();
                    if (this._idleResolve) {
                        this._idleResolve();
                        this._idleResolve = null;
                    }

                    if (!settled) {
                        const bestLine = lines[1] || { score: 0, mate: null, pv: '', move: bm.bestMove };
                        settle(null, {
                            score: bestLine.score,
                            mate: bestLine.mate ?? null,
                            bestMove: bm.bestMove || bestLine.move,
                            pv: bestLine.pv,
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
                        restoreOnDied();
                        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
                        settle(new DOMException('Aborted', 'AbortError'), null);
                        return;
                    }
                    this._engine.send(`position fen ${fen}`);
                    // Se incluye movetime 30000 (30s) como seguro contra cuelgues eternos
                    // en Depth 20+ al evaluar finales hiper-ramificados.
                    this._engine.send(`go depth ${depth} movetime 30000`);
                    this._engine.lineHandler = searchHandler;
                }
            };

            if (effectiveMultiPv !== this._activeMultiPv) {
                // MultiPV changed — must send setoption and sync with isready
                // before starting the search so Stockfish allocates the right
                // number of PV lines. isready forces all threads to synchronize,
                // so we only pay this cost when the value actually changes.
                console.log(`[Engine] MultiPV changed: ${this._activeMultiPv} -> ${effectiveMultiPv}`);
                this._activeMultiPv = effectiveMultiPv;
                this._engine.send(`setoption name MultiPV value ${effectiveMultiPv}`);
                this._engine.send('isready');
            } else {
                // MultiPV unchanged — skip the setoption+isready round-trip.
                // Send position + go directly; this eliminates the per-position
                // thread-synchronization overhead that caused 10 threads to be
                // dramatically slower than 2 threads.
                if (signal?.aborted || this._engine.state === EngineState.STOPPING) {
                    this._engine.state = EngineState.IDLE;
                    restoreOnDied();
                    if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
                    settle(new DOMException('Aborted', 'AbortError'), null);
                    return;
                }
                this._engine.lineHandler = searchHandler;
                this._engine.send(`position fen ${fen}`);
                // Seguro de 30s máximo por posición
                this._engine.send(`go depth ${depth} movetime 30000`);
            }
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
        this._activeMultiPv = DEFAULT_CONFIG.multiPv; // reset so next spawn re-applies correctly
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
                    console.log(`[Engine] Initializing with Threads: ${this._config.threads}, Hash: ${this._config.hash}MB, MultiPV: ${this._config.multiPv}`);
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
        this._activeMultiPv = DEFAULT_CONFIG.multiPv; // reset so next spawn re-applies correctly
        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
        this._idlePromise = Promise.resolve();
        this._engine.onDied = () => this._onEngineDied();
    }
}

module.exports = { StockfishProcess, DEFAULT_CONFIG };
