'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'analyses.json');
const DATA_DIR = path.dirname(STORE_PATH);

const FULL_DATA_DIR = path.join(DATA_DIR, 'full_analyses');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(FULL_DATA_DIR)) {
    fs.mkdirSync(FULL_DATA_DIR, { recursive: true });
}

function _load() {
    if (!fs.existsSync(STORE_PATH)) return { analyses: [] };
    try {
        const content = fs.readFileSync(STORE_PATH, 'utf8');
        return JSON.parse(content);
    } catch {
        return { analyses: [] };
    }
}

function _save(data) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

const GameStore = {
    getAll() {
        return _load().analyses;
    },

    getFull(gameId) {
        const filePath = path.join(FULL_DATA_DIR, `${gameId}.json`);
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return null;
        }
    },

    save(analysis, fullData = null) {
        const data = _load();
        
        const entry = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            ...analysis
        };

        const existingIdx = data.analyses.findIndex(a => a.gameId === analysis.gameId);
        if (existingIdx !== -1) {
            data.analyses[existingIdx] = entry;
        } else {
            data.analyses.push(entry);
        }

        _save(data);

        if (fullData) {
            const filePath = path.join(FULL_DATA_DIR, `${analysis.gameId}.json`);
            fs.writeFileSync(filePath, JSON.stringify(fullData, null, 2), 'utf8');
        }

        return entry;
    },

    getStats() {
        const { analyses } = _load();
        if (analyses.length === 0) return null;

        // Transform for frontend compatibility (flattening accuracy and providing defaults)
        const formattedGames = analyses.map(g => ({
            ...g,
            accuracy: g.white?.accuracy ?? 0,
            color: g.color ?? 'white',
            win: g.win ?? true,
            timeControl: g.timeControl ?? '10m'
        }));

        const lastGames = formattedGames.slice(-20).reverse();
        
        const avgWhite = lastGames.reduce((acc, g) => acc + (g.white?.accuracy || 0), 0) / lastGames.length;
        const avgBlack = lastGames.reduce((acc, g) => acc + (g.black?.accuracy || 0), 0) / lastGames.length;

        return {
            games: lastGames,
            summary: {
                totalAnalyses: analyses.length,
                avgAccuracyWhite: Math.round(avgWhite),
                avgAccuracyBlack: Math.round(avgBlack),
            }
        };
    },

    delete(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        const data = _load();
        const before = data.analyses.length;
        
        // Eliminar archivos de datos completos asociados
        ids.forEach(id => {
            const entry = data.analyses.find(a => a.id === id);
            if (entry && entry.gameId) {
                const fullPath = path.join(FULL_DATA_DIR, `${entry.gameId}.json`);
                if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            }
        });

        data.analyses = data.analyses.filter(a => !ids.includes(a.id));
        _save(data);
        return data.analyses.length < before;
    },

    clear() {
        _save({ analyses: [] });
    }
};

module.exports = { GameStore };
