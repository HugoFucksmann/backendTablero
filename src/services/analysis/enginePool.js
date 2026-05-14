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

        const numEngines = Math.max(1, engineConfig.threads ?? 1);
        const hashPerEngine = Math.max(16, Math.floor((engineConfig.hash ?? 128) / numEngines));

        this.engines = prebuiltEngines
            ?? Array.from({ length: numEngines }, () => new StockfishProcess());

        this._perEngineConfig = {
            ...engineConfig,
            threads: 1,
            hash: hashPerEngine,
        };
    }

    /**
     * Inicializa todos los engines propios en paralelo.
     * Si los engines fueron inyectados externamente (batch), no hace nada.
     */
    async init() {
        if (!this._ownsEngines) return;
        await Promise.all(
            this.engines.map(e => e.init(this._perEngineConfig))
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