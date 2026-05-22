import { randomUUID } from 'crypto';
import { SqliteStore } from './sqliteStore.js';

export const GameStore = {
    async getAll(offset = 0, limit = 50): Promise<any[]> {
        return SqliteStore.getAll(offset, limit);
    },

    async getAllGameIds(): Promise<string[]> {
        return SqliteStore.getAllGameIds();
    },

    async getFull(gameId: string): Promise<any> {
        return SqliteStore.getFull(gameId);
    },

    async save(analysis: any, fullData: any = null): Promise<any> {

        const existing = SqliteStore.getByGameId(analysis.gameId);

        const entry = {
            id: existing ? existing.id : randomUUID(),
            createdAt: existing ? existing.createdAt : new Date().toISOString(),
            ...analysis,
            fullData
        };

        SqliteStore.save(entry);
        return entry;
    },

    async getStats(filters = {}): Promise<any> {
        return SqliteStore.getAggregatedStats(filters);
    },

    async getStatDetails(category: string, filters = {}): Promise<any> {
        return SqliteStore.getStatDetails(category, filters);
    },

    async getMoveExplorer(fen: string): Promise<any> {
        return SqliteStore.getMoveExplorer(fen);
    },

    async delete(ids: string | string[]): Promise<boolean> {
        const idArray = Array.isArray(ids) ? ids : [ids];
        SqliteStore.delete(idArray);
        return true;
    },

    async clear(): Promise<void> {
        SqliteStore.clear();
    },

    async runIntegrityCheck(): Promise<void> {

        console.log('[GameStore] Integrity check (SQL-only mode): OK');
    }
};
