import { spawn, ChildProcess } from 'child_process';

const STOCKFISH_PATH = process.env.STOCKFISH_PATH || 'stockfish';

export const EngineState = {
    DEAD:      'dead',
    STARTING:  'starting',
    IDLE:      'idle',
    SEARCHING: 'searching',
    STOPPING:  'stopping',
} as const;

export type EngineStateType = typeof EngineState[keyof typeof EngineState];

export class EngineProcess {
    public state: EngineStateType;
    private _proc: ChildProcess | null;
    private _sessionId: number;
    private _lineBuf: string;
    public lineHandler: ((line: string) => void) | null;
    public onDied: ((sessionId: number) => void) | null;

    constructor() {
        this.state = EngineState.DEAD;
        this._proc = null;
        this._sessionId = 0;
        this._lineBuf = '';
        this.lineHandler = null;
        this.onDied = null;
    }

    public spawn(): Promise<void> {
        if (this._proc) {
            return Promise.reject(new Error('Engine already running'));
        }

        this._sessionId += 1;
        const currentSession = this._sessionId;

        this.state = EngineState.STARTING;
        this._lineBuf = '';

        return new Promise<void>((resolve, reject) => {
            try {
                console.log(`[Engine] Spawning: ${STOCKFISH_PATH}`);
                this._proc = spawn(STOCKFISH_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (err) {
                this.state = EngineState.DEAD;
                return reject(err);
            }

            if (this._proc.stderr) {
                this._proc.stderr.on('data', (data: Buffer) => {
                    console.error('[Engine STDERR]', data.toString().trim());
                });
            }

            this._proc.on('error', (err) => {
                if (this._sessionId !== currentSession) return;
                this._handleDeath(currentSession);
                reject(err);
            });

            this._proc.on('exit', () => {
                if (this._sessionId !== currentSession) return;
                this._handleDeath(currentSession);
            });

            if (this._proc.stdout) {
                this._proc.stdout.on('data', (chunk: Buffer) => {
                    if (this._sessionId !== currentSession) return;
                    
                    this._lineBuf += chunk.toString();
                    let newLineIdx: number;
                    while ((newLineIdx = this._lineBuf.indexOf('\n')) !== -1) {
                        const line = this._lineBuf.slice(0, newLineIdx).trim();
                        this._lineBuf = this._lineBuf.slice(newLineIdx + 1);
                        if (line && this.lineHandler) {
                            this.lineHandler(line);
                        }
                    }
                });
            }

            resolve();
        });
    }

    public send(command: string): void {
        if (this._proc?.stdin?.writable) {
            this._proc.stdin.write(command + '\n');
        }
    }

    public kill(): void {
        const proc = this._proc;
        this._proc = null;
        this.state = EngineState.DEAD;
        this.lineHandler = null;
        this._sessionId += 1;

        if (proc) {
            try { proc.stdin?.write('quit\n'); } catch {}
            try { proc.stdin?.destroy(); } catch {}
            try { proc.kill('SIGTERM'); } catch {}
        }
    }

    public get isAlive(): boolean {
        return this._proc !== null && this.state !== EngineState.DEAD;
    }

    private _handleDeath(session: number): void {
        if (this._sessionId !== session) return;
        this._proc = null;
        this.state = EngineState.DEAD;
        this.lineHandler = null;
        this._sessionId += 1;
        this.onDied?.(session);
    }
}
