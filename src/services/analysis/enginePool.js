'use strict';

const { StockfishProcess } = require('../../core/stockfishProcess');

/**
 * EnginePool
 * ──────────
 * Responsabilidad única: gestionar el ciclo de vida de los procesos Stockfish.
 *
 * Decide cuántos engines crear, cómo inicializarlos, y cómo destruirlos.
 * No sabe nada del análisis ni de las posiciones.
 */
class EnginePool {
    /**
     * @param {Object}   engineConfig
     * @param {number}   engineConfig.threads
     * @param {number}   engineConfig.hash
     * @param {number}   engineConfig.multiPv
     * @param {Object[]|null} prebuiltEngines  - Engines ya inicializados (modo batch).
     */
    constructor(engineConfig, prebuiltEngines = null) {
        this._multiPv = engineConfig.multiPv ?? 1;
        this._ownsEngines = !prebuiltEngines;

<<<<<<< HEAD
        const totalThreads = engineConfig.threads ?? 1;
        const numEngines = Math.max(1, totalThreads);

        const baseHash = Math.floor((engineConfig.hash ?? 128) / numEngines);
        const hashRemainder = (engineConfig.hash ?? 128) % numEngines;

        this._engineConfigs = Array.from({ length: numEngines }, (_, idx) => {
            const engineHash = baseHash + (idx < hashRemainder ? 1 : 0);
            const cappedHash = Math.min(2048, Math.max(16, engineHash));

            return {
                ...engineConfig,
                threads: 1,
                hash: cappedHash,
            };
        });

        this.totalAllocatedThreads = this._engineConfigs.reduce((sum, cfg) => sum + cfg.threads, 0);
        this.totalAllocatedHash = this._engineConfigs.reduce((sum, cfg) => sum + cfg.hash, 0);
=======
        const totalThreads = engineConfig.threads ?? Math.max(1, require('os').cpus().length - 1);
        const numEngines = Math.max(1, totalThreads);
        const threadsPerEngine = 1;
        const hashPerEngine = Math.min(512, Math.max(16, Math.floor((engineConfig.hash ?? 128) / numEngines)));
>>>>>>> cc4a7edef69c714bc9f5a89261cfa1fcb4a39def

        this.engines = prebuiltEngines
            ?? Array.from({ length: numEngines }, () => new StockfishProcess());
    }

    /**
     * Inicializa todos los engines propios en paralelo.
     * Si los engines fueron inyectados externamente (batch), no hace nada.
     */
    async init() {
        if (!this._ownsEngines) return;
        await Promise.all(
            this.engines.map((e, idx) => e.init(this._engineConfigs[idx]))
        );
    }

    /** Envía ucinewgame a todos los engines (limpia tablas de hash). */
    newGame() {
        this.engines.forEach(e => e.newGame());
    }

    /**
     * Destruye todos los engines propios.
     * Si fueron inyectados externamente, no hace nada (el caller es responsable).
     */
    destroy() {
        if (this._ownsEngines) {
            this.engines.forEach(e => e.destroy());
        }
    }

    get count() {
        return this.engines.length;
    }

    get ownsEngines() {
        return this._ownsEngines;
    }
}

module.exports = { EnginePool };