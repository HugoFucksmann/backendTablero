import os from 'os';
import { StockfishProcess } from '../../core/stockfishProcess.js';

export interface EnginePoolConfig {
    threads?: number;
    hash?: number;
    multiPv?: number;
    [key: string]: any;
}

export class EnginePool {
    public readonly engines: StockfishProcess[];
    private _ownsEngines: boolean;
    private _perEngineConfig: EnginePoolConfig;

    /**
     * @param engineConfig
     * @param prebuiltEngines  - Engines ya inicializados (modo batch).
     */
    constructor(engineConfig: EnginePoolConfig, prebuiltEngines: StockfishProcess[] | null = null) {
        this._ownsEngines = !prebuiltEngines;

        const totalThreads = engineConfig.threads ?? Math.max(1, os.cpus().length - 1);
        const numEngines = Math.max(1, totalThreads);
        const threadsPerEngine = 1;
        const hashPerEngine = Math.min(512, Math.max(16, Math.floor((engineConfig.hash ?? 128) / numEngines)));

        this.engines = prebuiltEngines
            ?? Array.from({ length: numEngines }, () => new StockfishProcess());

        this._perEngineConfig = {
            ...engineConfig,
            threads: threadsPerEngine,
            hash: hashPerEngine,
        };
    }

    /**
     * Inicializa todos los engines propios en paralelo.
     * Si los engines fueron inyectados externamente (batch), no hace nada.
     */
    public async init(): Promise<void> {
        if (!this._ownsEngines) return;
        await Promise.all(
            this.engines.map(e => e.init(this._perEngineConfig))
        );
    }

    /** Envía ucinewgame a todos los engines (limpia tablas de hash). */
    public newGame(): void {
        this.engines.forEach(e => e.newGame());
    }

    /**
     * Destruye todos los engines propios.
     * Si fueron inyectados externamente, no hace nada (el caller es responsable).
     */
    public destroy(): void {
        if (this._ownsEngines) {
            this.engines.forEach(e => e.destroy());
        }
    }

    public get count(): number {
        return this.engines.length;
    }

    public get ownsEngines(): boolean {
        return this._ownsEngines;
    }
}
