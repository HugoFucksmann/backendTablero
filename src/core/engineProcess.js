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
        this.state = EngineState.DEAD;
        this._proc = null;
        this._sessionId = 0;
        this._lineBuf = '';
        this.lineHandler = null;
        this.onDied = null;
    }

    spawn() {
        if (this._proc) throw new Error('Engine already running');

        this._sessionId += 1;
        const currentSession = this._sessionId;

        this.state = EngineState.STARTING;
        this._lineBuf = '';

        return new Promise((resolve, reject) => {
            try {
                console.log(`[Engine] Spawning: ${STOCKFISH_PATH}`);
                this._proc = spawn(STOCKFISH_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (err) {
                this.state = EngineState.DEAD;
                return reject(err);
            }

            this._proc.stderr.on('data', (data) => {
                console.error('[Engine STDERR]', data.toString().trim());
            });

            this._proc.on('error', (err) => {
                if (this._sessionId !== currentSession) return;
                this._handleDeath(currentSession);
                reject(err);
            });

            this._proc.on('exit', () => {
                if (this._sessionId !== currentSession) return;
                this._handleDeath(currentSession);
            });

            this._proc.stdout.on('data', (chunk) => {
                if (this._sessionId !== currentSession) return;
                
                this._lineBuf += chunk.toString();
                let newLineIdx;
                while ((newLineIdx = this._lineBuf.indexOf('\n')) !== -1) {
                    const line = this._lineBuf.slice(0, newLineIdx).trim();
                    this._lineBuf = this._lineBuf.slice(newLineIdx + 1);
                    if (line && this.lineHandler) {
                        this.lineHandler(line);
                    }
                }
            });

            resolve();
        });
    }

    send(command) {
        if (this._proc?.stdin?.writable) {
            this._proc.stdin.write(command + '\n');
        }
    }

    kill() {
        const proc = this._proc;
        this._proc = null;
        this.state = EngineState.DEAD;
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
        this._proc = null;
        this.state = EngineState.DEAD;
        this.lineHandler = null;
        this._sessionId += 1;
        this.onDied?.(session);
    }
}

module.exports = { EngineProcess, EngineState };
