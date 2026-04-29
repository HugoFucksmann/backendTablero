'use strict';

/**
 * stockfishProcess.js
 * ────────────────────
 * Responsibility: UCI protocol + serialised analysis queue.
 *
 * Uses:
 *   - EngineProcess  (engineProcess.js) for OS-level process management
 *   - parseInfoLine / parseBestmoveLine (uciParser.js) for output parsing
 *
 * Public API:
 *   await sf.init(config)
 *   sf.newGame()
 *   const result = await sf.analyzePosition(fen, depth, signal, onProgress, multiPv)
 *   await sf.stopAndWait()
 *   sf.stop()       — fire-and-forget
 *   sf.destroy()
 *
 * Core design rules:
 *   1. `_idlePromise` resolves ONLY when `bestmove` arrives — never earlier.
 *      This guarantees the engine is truly idle before the next command batch.
 *   2. Abort sends `stop`; the abort caller is rejected immediately but the
 *      queue is released only after the engine emits `bestmove`.
 *   3. `setoption` commands are sent only while IDLE, always followed by
 *      `isready` / `readyok` before `go` — strict UCI compliance.
 *   4. Config merges onto the CURRENT config (not DEFAULT_CONFIG) so re-calling
 *      init({ multiPv: 3 }) does not accidentally reset threads/hash.
 */

const { EngineProcess, EngineState } = require('./engineProcess');
const { parseInfoLine, parseBestmoveLine } = require('./uciParser');

const DEFAULT_CONFIG = {
    threads: Math.max(1, require('os').cpus().length - 1),
    hash:    128,
    multiPv: 1,
    depth:   18,
};

class StockfishProcess {
    constructor() {
        this._engine      = new EngineProcess();
        this._config      = { ...DEFAULT_CONFIG };
        this._initPromise = null;   // resolves when engine reaches IDLE after startup

        // Serialisation: each analyzePosition awaits this before proceeding.
        // Released only on `bestmove`.
        this._idlePromise = Promise.resolve();
        this._idleResolve = null;

        // Wire up crash handler
        this._engine.onDied = () => this._onEngineDied();
    }

    // ── Public: Lifecycle ────────────────────────────────────────────────────

    /**
     * Ensures the engine is alive and configured.
     * Safe to call multiple times — idempotent when engine is already IDLE.
     *
     * Merges `config` onto the current config (not onto DEFAULT_CONFIG),
     * so partial updates like { multiPv: 3 } never reset unrelated options.
     *
     * @param {Partial<typeof DEFAULT_CONFIG>} config
     * @returns {Promise<void>}
     */
    init(config = {}) {
        const merged = { ...this._config, ...config };

        // Already IDLE: apply any changed non-search options live
        if (this._engine.state === EngineState.IDLE) {
            const prev = this._config;
            if (JSON.stringify(merged) !== JSON.stringify(prev)) {
                // Apply hardware options only — multiPv is set per-search
                if (merged.threads !== prev.threads) {
                    this._engine.send(`setoption name Threads value ${merged.threads}`);
                }
                if (merged.hash !== prev.hash) {
                    this._engine.send(`setoption name Hash value ${merged.hash}`);
                }
                this._config = merged;
            }
            return this._initPromise; // already resolved
        }

        // Already starting — return the in-flight promise (deduplicate concurrent callers)
        if (this._initPromise) return this._initPromise;

        // Engine is dead — spawn and handshake
        this._config      = merged;
        this._initPromise = this._spawnAndHandshake();
        return this._initPromise;
    }

    newGame() {
        if (this._engine.state === EngineState.IDLE) {
            this._engine.send('ucinewgame');
        }
    }

    /**
     * Analyses a single position and returns the final result.
     *
     * Serialisation: if the engine is currently searching, this call awaits
     * `_idlePromise` (released by `bestmove`) before sending any commands.
     *
     * Cancellation via `signal.abort()`:
     *   - The caller's promise is rejected immediately with AbortError.
     *   - `stop` is sent to the engine.
     *   - `_idlePromise` is NOT released here; it is released when `bestmove` arrives.
     *     This ensures the next search only starts once the engine is truly idle.
     *
     * @param {string}        fen
     * @param {number}        depth
     * @param {AbortSignal}   signal
     * @param {Function|null} onProgress
     * @param {number|null}   multiPv
     * @returns {Promise<{score, mate, bestMove, pv, lines[]}>}
     */
    async analyzePosition(fen, depth, signal = null, onProgress = null, multiPv = null) {
        if (!fen || typeof fen !== 'string') throw new Error('Invalid FEN');

        // Ensure engine is alive
        if (this._engine.state === EngineState.DEAD) {
            this._initPromise = null; // allow re-init after crash
            await this.init(this._config);
        } else {
            await this._initPromise;
        }

        // Wait for any previous search to fully drain (bestmove received)
        const t0 = performance.now();
        await this._idlePromise;
        const tWait = Math.round(performance.now() - t0);

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (this._engine.state !== EngineState.IDLE) {
            throw new Error(`Unexpected engine state before search: ${this._engine.state}`);
        }

        const effectiveMultiPv = multiPv ?? this._config.multiPv;

        return new Promise((resolve, reject) => {
            // Claim the idle slot synchronously (before any await)
            this._idlePromise = new Promise(r => { this._idleResolve = r; });
            this._engine.state = EngineState.SEARCHING;

            const lines      = {};
            let lastBestMove = '';
            let settled      = false;

            // ── settle: called at most once ───────────────────────────────────
            const settle = (err, result) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                const elapsed = Math.round(performance.now() - t0);
                console.log(
                    `[Stockfish] ${err ? 'Aborted' : 'Done'} | ` +
                    `total=${elapsed}ms wait=${tWait}ms depth=${depth} ` +
                    `fen=${fen.split(' ').slice(0, 2).join(' ')}`
                );
                if (err) reject(err);
                else     resolve(result);
            };

            // ── Abort handler ─────────────────────────────────────────────────
            // Rejects the caller immediately but does NOT release _idlePromise.
            // We must wait for the engine's `bestmove` response before allowing
            // the next search to start (strict UCI compliance).
            const onAbort = () => {
                if (this._engine.state === EngineState.SEARCHING) {
                    this._engine.state = EngineState.STOPPING;
                    this._engine.send('stop');
                }
                settle(new DOMException('Aborted', 'AbortError'), null);
            };
            signal?.addEventListener('abort', onAbort);

            // ── Line handler for the search phase ─────────────────────────────
            const searchHandler = (line) => {
                // `bestmove` ALWAYS releases the idle slot — even after abort.
                const bm = parseBestmoveLine(line);
                if (bm !== null) {
                    lastBestMove = bm.bestMove || lastBestMove;

                    // Engine is now truly idle
                    this._engine.state    = EngineState.IDLE;
                    this._engine.lineHandler = null;
                    if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }

                    // Resolve caller only if not already settled (i.e. not aborted)
                    if (!settled) {
                        if (!lines[1]) {
                            lines[1] = { multipv: 1, score: 0, mate: null, pv: '', move: lastBestMove };
                        }
                        settle(null, {
                            score:    lines[1].score,
                            mate:     lines[1].mate ?? null,
                            bestMove: lastBestMove || lines[1].move,
                            pv:       lines[1].pv,
                            lines:    Object.values(lines).sort((a, b) => a.multipv - b.multipv),
                        });
                    }
                    return;
                }

                // While stopping, ignore info lines (caller already rejected)
                if (this._engine.state === EngineState.STOPPING) return;

                const info = parseInfoLine(line);
                if (info !== null) {
                    const { multipv: idx, depth: d, score, mate, pv, move } = info;
                    if (!lines[idx]) lines[idx] = { multipv: idx, score: 0, mate: null, pv: '', move: '', depth: 0 };

                    lines[idx].depth = d;
                    lines[idx].score = score;
                    lines[idx].mate  = mate;
                    lines[idx].pv    = pv;
                    lines[idx].move  = move;

                    if (onProgress) {
                        onProgress({
                            depth:    lines[1]?.depth    ?? 0,
                            score:    lines[1]?.score    ?? 0,
                            mate:     lines[1]?.mate     ?? null,
                            bestMove: lines[1]?.move     ?? '',
                            lines:    Object.values(lines).sort((a, b) => a.multipv - b.multipv),
                        });
                    }
                }
            };

            // ── readyok handler: fires go ─────────────────────────────────────
            // We always go through setoption + isready/readyok before each search.
            // This ensures MultiPV is applied and acknowledged before `go`.
            this._engine.lineHandler = (line) => {
                if (line === 'readyok') {
                    // Check we weren't aborted during the isready round-trip
                    if (signal?.aborted || this._engine.state === EngineState.STOPPING) {
                        // Engine never started searching; release idle and settle
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

    /**
     * Sends `stop` and waits for the engine to become idle (bestmove received).
     * @returns {Promise<void>}
     */
    async stopAndWait() {
        if (this._engine.state === EngineState.SEARCHING) {
            this._engine.state = EngineState.STOPPING;
            this._engine.send('stop');
        }
        await this._idlePromise;
    }

    /** Fire-and-forget stop — does not wait for bestmove. */
    stop() {
        if (this._engine.state === EngineState.SEARCHING) {
            this._engine.state = EngineState.STOPPING;
            this._engine.send('stop');
        }
    }

    /** Kills the engine immediately and resets all state. */
    destroy() {
        console.log('[Stockfish] destroy() called');
        this._initPromise = null;

        // Unblock any caller waiting on _idlePromise
        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
        this._idlePromise = Promise.resolve();

        this._engine.kill(); // increments session id; stale exit events are ignored
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Spawns the process and runs the UCI handshake.
     * Returns a Promise that resolves when the engine reaches IDLE state.
     */
    async _spawnAndHandshake() {
        await this._engine.spawn(); // throws if spawn fails

        return new Promise((resolve, reject) => {
            // Override onDied to also reject the init promise if engine dies during handshake
            const prevOnDied    = this._engine.onDied;
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
                    this._engine.state       = EngineState.IDLE;
                    this._engine.lineHandler = null;
                    this._engine.onDied      = prevOnDied; // restore normal handler
                    resolve();
                }
            };

            this._engine.send('uci');
        });
    }

    /** Called when the OS process exits unexpectedly (crash, OOM, etc.). */
    _onEngineDied() {
        this._initPromise = null;

        // Unblock any caller waiting on idle so they can recover / re-init
        if (this._idleResolve) { this._idleResolve(); this._idleResolve = null; }
        this._idlePromise = Promise.resolve();

        // Restore onDied to default
        this._engine.onDied = () => this._onEngineDied();
    }
}

module.exports = { StockfishProcess, DEFAULT_CONFIG };