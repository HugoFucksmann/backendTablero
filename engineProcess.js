'use strict';

const { spawn } = require('child_process');
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || 'stockfish';

const EngineState = Object.freeze({
    DEAD:      'dead',
    STARTING:  'starting',
    IDLE:      'idle',
    SEARCHING: 'searching',
    STOPPING:  'stopping',
});

class EngineProcess {
    constructor() {
        this.state         = EngineState.DEAD;
        this._proc         = null;
        this._sessionId    = 0;
        this._lineBuf      = '';
        this.lineHandler   = null;
        this.onDied        = null;
    }

    spawn() {
        if (this._proc) throw new Error('Already alive');

        this._sessionId += 1;
        const session = this._sessionId;

        this.state   = EngineState.STARTING;
        this._lineBuf = '';

        return new Promise((resolve, reject) => {
            let proc;
            try {
                console.log(`[Engine] Spawning at: ${STOCKFISH_PATH}`);
                proc = spawn(STOCKFISH_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                this.state = EngineState.DEAD;
                return reject(e);
            }

            this._proc = proc;

            proc.stderr.on('data', (d) => console.error('[Engine STDERR]', d.toString().trim()));

            proc.on('error', (err) => {
                if (this._sessionId !== session) return;
                this._handleDeath(session);
                reject(err);
            });

            proc.on('exit', (code, sig) => {
                if (this._sessionId !== session) return;
                this._handleDeath(session);
            });

            proc.stdout.on('data', (chunk) => {
                if (this._sessionId !== session) return;
                this._lineBuf += chunk.toString();
                let nl;
                while ((nl = this._lineBuf.indexOf('\n')) !== -1) {
                    const line = this._lineBuf.slice(0, nl).trim();
                    this._lineBuf = this._lineBuf.slice(nl + 1);
                    if (line && this.lineHandler) this.lineHandler(line);
                }
            });

            resolve();
        });
    }

    send(cmd) {
        if (this._proc?.stdin?.writable) {
            this._proc.stdin.write(cmd + '\n');
        }
    }

    kill() {
        const proc = this._proc;
        this._proc  = null;
        this.state  = EngineState.DEAD;
        this.lineHandler = null;
        this._sessionId += 1;

        if (proc) {
            try { proc.stdin.write('quit\n'); } catch {}
            try { proc.stdin.destroy(); } catch {}
            try { proc.kill('SIGTERM'); } catch {}
        }
    }

    get isAlive() {
        return this._proc !== null && this.state !== EngineState.DEAD;
    }

    _handleDeath(session) {
        if (this._sessionId !== session) return;
        this._proc    = null;
        this.state    = EngineState.DEAD;
        this.lineHandler = null;
        this._sessionId += 1;
        this.onDied?.(session);
    }
}

module.exports = { EngineProcess, EngineState };
