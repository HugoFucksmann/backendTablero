'use strict';

/**
 * StockfishProcess
 * ─────────────────
 * Manages a single native Stockfish binary via stdin/stdout.
 * Mirror of the browser stockfishService.js but using child_process instead of Worker.
 *
 * Lifecycle:
 *   const sf = new StockfishProcess();
 *   await sf.init(config);
 *   sf.newGame();
 *   const result = await sf.analyzePosition(fen, depth, signal, onProgress, multiPv);
 *   sf.destroy();
 */

const { spawn } = require('child_process');

const STOCKFISH_PATH = process.env.STOCKFISH_PATH || 'stockfish';

const DEFAULT_CONFIG = {
    depth: 18,
    multiPv: 1,
    threads: Math.max(1, require('os').cpus().length - 1), // leave one core for Node
    hash: 128, // MB — larger than WASM default (32)
};

class StockfishProcess {
    constructor() {
        this._proc = null;
        this._ready = false;
        this._initPromise = null;
        this._config = { ...DEFAULT_CONFIG };

        // Serialise requests: next analysis waits for current one to finish
        this._idleResolve = null;
        this._idlePromise = Promise.resolve();

        this._activeReject = null;
        this._messageBuffer = '';
        this._handler = null; // current line handler callback
    }

    // ── Init ────────────────────────────────────────────────────────────────

    init(config = {}) {
        const newConfig = { ...DEFAULT_CONFIG, ...config };

        // If already initialized, update settings if they changed
        if (this._initPromise && this._ready) {
            const changed = JSON.stringify(newConfig) !== JSON.stringify(this._config);
            if (changed) {
                console.log('[Stockfish] Updating configuration:', config);
                if (newConfig.threads !== this._config.threads) {
                    this._send(`setoption name Threads value ${newConfig.threads}`);
                }
                if (newConfig.hash !== this._config.hash) {
                    this._send(`setoption name Hash value ${newConfig.hash}`);
                }
                if (newConfig.multiPv !== this._config.multiPv) {
                    this._send(`setoption name MultiPV value ${newConfig.multiPv}`);
                }
                this._config = newConfig;
                this._send('isready');
                return this._initPromise;
            }
            return this._initPromise;
        }

        if (this._initPromise) return this._initPromise;

        this._config = newConfig;

        this._initPromise = new Promise((resolve, reject) => {
            try {
                console.log(`[Stockfish] Spawning engine at: ${STOCKFISH_PATH}`);
                this._proc = spawn(STOCKFISH_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                this._initPromise = null;
                return reject(new Error(`Cannot spawn Stockfish at "${STOCKFISH_PATH}": ${e.message}`));
            }

            this._proc.stderr.on('data', (d) => {
                console.error('[Stockfish STDERR]', d.toString().trim());
            });

            this._proc.on('error', (err) => {
                console.error('[Stockfish] Process error:', err.message);
                this.destroy();
                reject(err);
            });

            this._proc.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    console.warn(`[Stockfish] Process exited with code ${code}`);
                }
                this._ready = false;
                this._initPromise = null; // Important: allow re-init on next call
                if (this._activeReject) {
                    this._activeReject(new DOMException('Engine exited', 'AbortError'));
                    this._activeReject = null;
                }
            });

            // Accumulate stdout into lines
            this._proc.stdout.on('data', (chunk) => {
                this._messageBuffer += chunk.toString();
                let newline;
                while ((newline = this._messageBuffer.indexOf('\n')) !== -1) {
                    const line = this._messageBuffer.slice(0, newline).trim();
                    this._messageBuffer = this._messageBuffer.slice(newline + 1);
                    if (line) this._onLine(line);
                }
            });

            // Boot UCI handshake
            if (this._proc.stdin.writable) {
                this._proc.stdin.write('uci\n');
            } else {
                reject(new Error('Stockfish stdin is not writable'));
            }

            this._handler = (line) => {
                if (line === 'uciok') {
                    this._send(`setoption name Threads value ${this._config.threads}`);
                    this._send(`setoption name Hash value ${this._config.hash}`);
                    this._send(`setoption name MultiPV value ${this._config.multiPv}`);
                    this._send('isready');
                }
                if (line === 'readyok' && !this._ready) {
                    this._ready = true;
                    this._handler = null;
                    resolve();
                }
            };
        });

        return this._initPromise;
    }

    newGame() {
        if (this._ready) this._send('ucinewgame');
    }

    // ── Analyze ─────────────────────────────────────────────────────────────

    /**
     * @param {string}   fen
     * @param {number}   depth
     * @param {AbortSignal|null} signal
     * @param {Function|null}    onProgress  — called with partial results on each `info` line
     * @param {number}   multiPv
     * @returns {Promise<{score, mate, bestMove, pv, lines[]}>}
     */
    async analyzePosition(fen, depth, signal = null, onProgress = null, multiPv = null) {
        if (!fen || typeof fen !== 'string') throw new Error('Invalid FEN');

        // Robustness: ensure process is alive
        if (!this._proc || !this._ready) {
            console.log('[Stockfish] Engine not ready, re-initializing…');
            await this.init(this._config);
        }

        const t0 = performance.now();
        await this._idlePromise; // wait for any running search
        const tWait = performance.now() - t0;

        const effectiveMultiPv = multiPv ?? this._config.multiPv;

        return new Promise((resolve, reject) => {
            if (!this._ready) return reject(new Error('Stockfish not ready'));
            if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));

            let finished = false;
            this._activeReject = reject;

            // Grab the idle slot
            this._idlePromise = new Promise(r => { this._idleResolve = r; });

            const cleanup = (err) => {
                if (finished) return;
                finished = true;
                this._handler = null;
                this._activeReject = null;
                if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
                signal?.removeEventListener('abort', onAbort);
                const elapsed = Math.round(performance.now() - t0);
                console.log(`[Stockfish] ${err ? 'Aborted' : 'Done'} in ${elapsed}ms (wait: ${Math.round(tWait)}ms) depth=${depth} fen=${fen.split(' ').slice(0, 2).join(' ')}`);
            };

            const onAbort = () => {
                this._send('stop');
                cleanup(true);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort);

            // Per-line data
            const lines = {};
            let lastBestMove = '';

            const searchHandler = (line) => {
                if (finished) return;

                if (line.startsWith('info') && line.includes('score')) {
                    const mpvMatch = line.match(/multipv (\d+)/);
                    const depthMatch = line.match(/depth (\d+)/);
                    const cpMatch = line.match(/score cp (-?\d+)/);
                    const mateMatch = line.match(/score mate (-?\d+)/);
                    const pvMatch = line.match(/ pv (.+)/);
                    const idx = mpvMatch ? parseInt(mpvMatch[1]) : 1;

                    if (!lines[idx]) lines[idx] = { multipv: idx, score: 0, mate: null, pv: '', move: '', depth: 0 };

                    if (depthMatch) lines[idx].depth = parseInt(depthMatch[1]);
                    if (cpMatch) lines[idx].score = parseInt(cpMatch[1]);
                    if (mateMatch) { lines[idx].mate = parseInt(mateMatch[1]); lines[idx].score = 0; }
                    if (pvMatch) {
                        const pv = pvMatch[1].trim();
                        lines[idx].pv = pv;
                        lines[idx].move = pv.split(' ')[0];
                    }

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

                if (line.startsWith('bestmove')) {
                    const bm = line.split(' ')[1];
                    if (bm && bm !== '(none)') lastBestMove = bm;
                    if (!lines[1]) lines[1] = { multipv: 1, score: 0, mate: null, pv: '', move: lastBestMove };

                    const result = {
                        score: lines[1].score,
                        mate: lines[1].mate ?? null,
                        bestMove: lastBestMove || lines[1].move,
                        pv: lines[1].pv,
                        lines: Object.values(lines).sort((a, b) => a.multipv - b.multipv),
                    };

                    cleanup(false);
                    resolve(result);
                }
            };

            // Send position + go
            this._handler = (line) => {
                if (line === 'readyok') {
                    this._send(`position fen ${fen}`);
                    this._send(`go depth ${depth}`);
                    this._handler = searchHandler;
                }
            };

            this._send(`setoption name MultiPV value ${effectiveMultiPv}`);
            this._send('isready');
        });
    }

    stop() {
        if (this._proc) this._send('stop');
    }

    destroy() {
        if (this._proc) {
            try { this._send('quit'); } catch { /* ignore */ }
            this._proc.stdin.destroy();
            this._proc.kill('SIGTERM');
            this._proc = null;
        }
        this._ready = false;
        this._initPromise = null;
        this._handler = null;

        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
        this._idlePromise = Promise.resolve();

        if (this._activeReject) {
            this._activeReject(new DOMException('Engine destroyed', 'AbortError'));
            this._activeReject = null;
        }
    }

    // ── Private ─────────────────────────────────────────────────────────────

    _send(cmd) {
        if (this._proc?.stdin?.writable) {
            this._proc.stdin.write(cmd + '\n');
        }
    }

    _onLine(line) {
        if (this._handler) this._handler(line);
    }
}

module.exports = { StockfishProcess, DEFAULT_CONFIG };