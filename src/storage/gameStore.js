'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'analyses.json');
const DATA_DIR = path.dirname(STORE_PATH);
const FULL_DATA_DIR = path.join(DATA_DIR, 'full_analyses');

// ─── Inicialización de directorios ───────────────────────────────────────────
// Usamos sync solo en startup (no durante request handling).
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FULL_DATA_DIR)) fs.mkdirSync(FULL_DATA_DIR, { recursive: true });

const { SqliteStore } = require('./sqliteStore');

const GameStore = {
    async getAll(offset = 0, limit = 50) {
        return SqliteStore.getAll(offset, limit);
    },

    async getFull(gameId) {
        const filePath = path.join(FULL_DATA_DIR, `${gameId}.json`);
        try {
            const content = await fsp.readFile(filePath, 'utf8');
            return JSON.parse(content);
        } catch {
            return null;
        }
    },

    async save(analysis, fullData = null) {
        const entry = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            ...analysis,
        };

        SqliteStore.save(entry);

        if (fullData) {
            const filePath = path.join(FULL_DATA_DIR, `${analysis.gameId}.json`);
            await fsp.writeFile(filePath, JSON.stringify(fullData, null, 2), 'utf8');
        }

        return entry;
    },

    async getStats(filters = {}) {
        return SqliteStore.getAggregatedStats(filters);
    },

    async delete(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        
        // Obtenemos los gameIds antes de borrar para limpiar archivos
        const all = SqliteStore.getAll(0, 1000); // Rango razonable para encontrar los IDs
        const toDelete = all.filter(a => ids.includes(a.id));

        for (const entry of toDelete) {
            if (entry.gameId) {
                const fullPath = path.join(FULL_DATA_DIR, `${entry.gameId}.json`);
                await fsp.unlink(fullPath).catch(() => {});
            }
        }

        SqliteStore.delete(ids);
        return true;
    },

    async clear() {
        SqliteStore.clear();
        const files = await fsp.readdir(FULL_DATA_DIR);
        for (const file of files) {
            await fsp.unlink(path.join(FULL_DATA_DIR, file)).catch(() => {});
        }
    },
};

module.exports = { GameStore };
