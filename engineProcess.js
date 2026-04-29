'use strict';

/**
 * engineProcess.js
 * ─────────────────
 * Responsibility: OS-level process management for a Stockfish binary.
 *
 * This module ONLY deals with:
 *   - spawn / kill / stdin write
 *   - stdout buffering and line dispatch
 *   - Engine lifecycle state machine  (DEAD → STARTING → IDLE ↔ SEARCHING → STOPPING → IDLE)
 *   - Session guard: event listeners on old processes NEVER mutate state for new ones
 *
 * It knows nothing about UCI options, analysis, or search logic.
 * Consumers install a `lineHandler` callback and call `send()` directly.
 */

const { spawn } = require('child_process');

const STOCKFISH_PATH = process.env.STOCKFISH_PATH || 'stockfish';

/** Explicit engine lifecycle states. */
const EngineState = Object.freeze({
    DEAD:      'dead',      // no process running
    STARTING:  'starting',  // spawned, UCI handshake in progress
    IDLE:      'idle',      // ready, no search running
    SEARCHING: 'searching', // `go` sent, waiting for `bestmove`
    STOPPING:  'stopping',  // `stop` sent, waiting for `bestmove`
});

class EngineProcess {
    constructor() {
        this.state         = EngineState.DEAD;
        this._proc         = null;
        this._sessionId    = 0;   // incremented on every spawn; guards stale event callbacks
        this._lineBuf      = '';
        this.lineHandler   = null; // set by consumers to receive parsed lines
        this.onDied        = null; // optional callback: (sessionId) => void
    }

    // ── Process control ──────────────────────────────────────────────────────

    /**
     * Spawns the Stockfish process.
     * Returns a Promise that resolves when the process is ready to receive stdin,
     * or rejects if the spawn itself fails.
     *
     * Note: the UCI handshake is NOT done here — that is the consumer's job.
     *       This method only ensures the OS process is running.
     */
    spawn() {
        if (this._proc) {
            throw new Error('EngineProcess.spawn() called while a process is already alive');
        }

        this._sessionId += 1;
        const session = this._sessionId; // capture for stale-closure guard

        this.state   = EngineState.STARTING;
        this._lineBuf = '';

        return new Promise((resolve, reject) => {
            let proc;
            try {
                console.log(`[Engine] Spawning at: ${STOCKFISH_PATH}`);
                proc = spawn(STOCKFISH_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                this.state = EngineState.DEAD;
                return reject(new Error(`Cannot spawn Stockfish: ${e.message}`));
            }

            this._proc = proc;

            proc.stderr.on('data', (d) =>
                console.error('[Engine STDERR]', d.toString().trim())
            );

            proc.on('error', (err) => {
                // Only act if this is still our active session
                if (this._sessionId !== session) return;
                console.error('[Engine] spawn error:', err.message);
                this._handleDeath(session);
                reject(err);
            });

            proc.on('exit', (code, sig) => {
                // Guard: ignore exit events from old sessions
                if (this._sessionId !== session) return;
                const label = code !== null ? `code=${code}` : `signal=${sig}`;
                console.warn(`[Engine] exited (${label})`);
                this._handleDeath(session);
            });

            proc.stdout.on('data', (chunk) => {
                // Guard: ignore stdout from old sessions
                if (this._sessionId !== session) return;
                this._lineBuf += chunk.toString();
                let nl;
                while ((nl = this._lineBuf.indexOf('\n')) !== -1) {
                    const line = this._lineBuf.slice(0, nl).trim();
                    this._lineBuf = this._lineBuf.slice(nl + 1);
                    if (line && this.lineHandler) this.lineHandler(line);
                }
            });

            resolve(); // process is running, handshake is the consumer's job
        });
    }

    /**
     * Sends a raw UCI command string.
     * Silently no-ops if stdin is not writable (e.g. process is dead).
     */
    send(cmd) {
        if (this._proc?.stdin?.writable) {
            this._proc.stdin.write(cmd + '\n');
        }
    }

    /**
     * Kills the current process immediately.
     * After this call, `state` is DEAD and `_proc` is null.
     * Any subsequent exit/error events from the killed process are ignored
     * thanks to the session guard.
     */
    kill() {
        console.log('[Engine] kill() called');
        const proc = this._proc;
        this._proc  = null;
        this.state  = EngineState.DEAD;
        this.lineHandler = null;

        // Increment session so the dying process's events are ignored
        this._sessionId += 1;

        if (proc) {
            try { proc.stdin.write('quit\n'); }  catch { /* ignore */ }
            try { proc.stdin.destroy(); }          catch { /* ignore */ }
            try { proc.kill('SIGTERM'); }          catch { /* ignore */ }
        }
    }

    get isAlive() {
        return this._proc !== null && this.state !== EngineState.DEAD;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _handleDeath(session) {
        // Double-check session to avoid acting on a kill() we already handled
        if (this._sessionId !== session) return;
        this._proc    = null;
        this.state    = EngineState.DEAD;
        this.lineHandler = null;
        this._sessionId += 1; // prevent any further events from this session
        this.onDied?.(session);
    }
}

module.exports = { EngineProcess, EngineState };
