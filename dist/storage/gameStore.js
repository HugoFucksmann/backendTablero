import { randomUUID } from 'crypto';
import { SqliteStore } from './sqliteStore.js';
export const GameStore = {
    async getAll(offset = 0, limit = 50) {
        return SqliteStore.getAll(offset, limit);
    },
    async getAllGameIds() {
        return SqliteStore.getAllGameIds();
    },
    async getFull(gameId) {
        return SqliteStore.getFull(gameId);
    },
    async save(analysis, fullData = null) {
        // Check if we already have an analysis for this gameId to avoid duplicates
        const existing = SqliteStore.getByGameId(analysis.gameId);
        const entry = {
            id: existing ? existing.id : randomUUID(),
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            ...analysis,
            fullData // Pasamos los datos completos al SqliteStore
        };
        SqliteStore.save(entry);
        return entry;
    },
    async getStats(filters = {}) {
        return SqliteStore.getAggregatedStats(filters);
    },
    async getStatDetails(category, filters = {}) {
        return SqliteStore.getStatDetails(category, filters);
    },
    async getMoveExplorer(fen) {
        return SqliteStore.getMoveExplorer(fen);
    },
    async delete(ids) {
        const idArray = Array.isArray(ids) ? ids : [ids];
        SqliteStore.delete(idArray);
        return true;
    },
    async clear() {
        SqliteStore.clear();
    },
    async runIntegrityCheck() {
        // Ya no es necesario el chequeo de archivos huérfanos ya que todo reside en SQL 
        // con claves foráneas y borrado en cascada.
        console.log('[GameStore] Integrity check (SQL-only mode): OK');
    }
};
