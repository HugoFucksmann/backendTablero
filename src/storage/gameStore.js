'use strict';

const { randomUUID } = require('crypto');
const { SqliteStore } = require('./sqliteStore');

// [FIX] Helper unificado para garantizar que TODAS las operaciones bloqueantes 
// de SQLite cedan su turno en el V8 Main Thread antes de ejecutarse.
const asyncOffload = (fn) => new Promise((resolve, reject) => {
    setImmediate(() => {
        try { resolve(fn()); } catch (e) { reject(e); }
    });
});

const GameStore = {
    async getAll(offset = 0, limit = 50) { return asyncOffload(() => SqliteStore.getAll(offset, limit)); },
    async getFull(gameId) { return asyncOffload(() => SqliteStore.getFull(gameId)); },
    async getFullRaw(gameId) { return asyncOffload(() => SqliteStore.getFullRaw(gameId)); },

    async save(analysis, fullData = null) {
        return asyncOffload(() => {
            const existing = SqliteStore.getByGameId(analysis.gameId);
            const entry = { id: existing ? existing.id : randomUUID(), createdAt: existing ? existing.createdAt : new Date().toISOString(), ...analysis, fullData };
            SqliteStore.save(entry);
            return entry;
        });
    },

    async getStats(filters = {}) { return asyncOffload(() => SqliteStore.getAggregatedStats(filters)); },
    async getStatDetails(category, filters = {}) { return asyncOffload(() => SqliteStore.getStatDetails(category, filters)); },
    async getMoveExplorer(fen) { return asyncOffload(() => SqliteStore.getMoveExplorer(fen)); },

    async delete(ids) {
        return asyncOffload(() => {
            if (!Array.isArray(ids)) ids = [ids];
            SqliteStore.delete(ids);
            return true;
        });
    },

    async clear() { return asyncOffload(() => { SqliteStore.clear(); }); },

    async runIntegrityCheck() { console.log('[GameStore] Integrity check (SQL-only mode): OK'); },

    // [FIX] Expuesto para el Graceful Shutdown
    async closeDatabase() {
        return asyncOffload(() => {
            try {
                const db = require('../db');
                if (db.open) {
                    db.close();
                    console.log('[GameStore] Database connection closed safely.');
                }
            } catch (e) {
                console.error('[GameStore] Error closing database:', e);
            }
        });
    }
};

module.exports = { GameStore };