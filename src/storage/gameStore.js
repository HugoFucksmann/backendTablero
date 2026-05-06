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

// ─── I/O Asíncrono ───────────────────────────────────────────────────────────
// Principio: nunca bloquear el event loop durante el manejo de mensajes WS.

async function _load() {
    try {
        const content = await fsp.readFile(STORE_PATH, 'utf8');
        return JSON.parse(content);
    } catch {
        return { analyses: [] };
    }
}

async function _save(data) {
    // Escritura atómica: escribir a .tmp primero y luego renombrar
    // para evitar corrupción si el proceso muere a mitad de escritura.
    const tmp = `${STORE_PATH}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, STORE_PATH);
}

// ─── Helpers de Agregación ───────────────────────────────────────────────────

/**
 * Agrega los acumuladores de fase de múltiples partidas en un promedio ponderado.
 * @param {Array} games - Análisis con campo `accuracyByPhase`
 * @returns {Array<{phase, accuracy, color}>}
 */
function _aggregatePhases(games) {
    const PHASE_COLORS = { 'Apertura': '#4caf50', 'Medio Juego': '#ff9800', 'Final': '#2196f3' };
    const agg = {};

    for (const game of games) {
        if (!Array.isArray(game.accuracyByPhase)) continue;
        for (const { phase, accuracy } of game.accuracyByPhase) {
            if (!agg[phase]) agg[phase] = { sum: 0, count: 0 };
            agg[phase].sum += accuracy;
            agg[phase].count++;
        }
    }

    const ORDER = ['Apertura', 'Medio Juego', 'Final'];
    return ORDER
        .filter(p => agg[p]?.count > 0)
        .map(phase => ({
            phase,
            accuracy: Math.round(agg[phase].sum / agg[phase].count),
            color: PHASE_COLORS[phase],
        }));
}

/**
 * Distribución porcentual de calidad de jugadas entre múltiples partidas.
 * Métrica: porcentaje de jugadas de cada tipo sobre el total de jugadas no-libro.
 * Es scale-invariant: válido con cualquier cantidad de partidas.
 *
 * @param {Array} games
 * @returns {Array<{label, pct, count, color}>} - ordenado de mejor a peor calidad
 */
function _aggregateMoveQuality(games) {
    const ALL_LABELS = ['Brillante', 'Mejor', 'Excelente', 'Bueno', 'Imprecisión', 'Error', 'Error grave'];
    const LABEL_COLORS = {
        'Brillante':   '#7c4dff',
        'Mejor':       '#4caf50',
        'Excelente':   '#8bc34a',
        'Bueno':       '#cddc39',
        'Imprecisión': '#ff9800',
        'Error':       '#f44336',
        'Error grave': '#b71c1c',
    };

    const totalByLabel = {};
    let totalNonBook = 0;

    for (const game of games) {
        if (!game.labelCounts || typeof game.labelCounts !== 'object') continue;
        for (const [label, count] of Object.entries(game.labelCounts)) {
            totalByLabel[label] = (totalByLabel[label] ?? 0) + count;
            totalNonBook += count;
        }
    }

    if (totalNonBook === 0) return [];

    return ALL_LABELS
        .filter(label => totalByLabel[label] > 0)
        .map(label => ({
            label,
            count: totalByLabel[label],
            pct: Math.round((totalByLabel[label] / totalNonBook) * 100),
            color: LABEL_COLORS[label],
        }));
}

// ─── GameStore ────────────────────────────────────────────────────────────────

const GameStore = {
    async getAll() {
        const { analyses } = await _load();
        return analyses;
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
        const data = await _load();

        const entry = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            ...analysis,
        };

        const existingIdx = data.analyses.findIndex(a => a.gameId === analysis.gameId);
        if (existingIdx !== -1) {
            data.analyses[existingIdx] = entry;
        } else {
            data.analyses.push(entry);
        }

        await _save(data);

        if (fullData) {
            const filePath = path.join(FULL_DATA_DIR, `${analysis.gameId}.json`);
            await fsp.writeFile(filePath, JSON.stringify(fullData, null, 2), 'utf8');
        }

        return entry;
    },

    async getStats() {
        const { analyses } = await _load();
        if (analyses.length === 0) return null;

        const formattedGames = analyses.map(g => {
            const color = g.color ?? 'white';
            const myAccuracy = color === 'white'
                ? (g.white?.accuracy ?? 0)
                : (g.black?.accuracy ?? 0);
            return {
                ...g,
                accuracy: myAccuracy,
                color,
                win: g.win ?? true,
                timeControl: g.timeControl ?? null,
            };
        });

        const lastGames = formattedGames.slice(-20).reverse();

        const avgMyAccuracy = lastGames.reduce((acc, g) => acc + (g.accuracy || 0), 0) / lastGames.length;
        const avgWhite = lastGames.reduce((acc, g) => acc + (g.white?.accuracy || 0), 0) / lastGames.length;
        const avgBlack = lastGames.reduce((acc, g) => acc + (g.black?.accuracy || 0), 0) / lastGames.length;

        // Agregaciones cross-game: fase y táctica
        const accuracyByPhase = _aggregatePhases(lastGames);
        const moveQuality = _aggregateMoveQuality(lastGames);

        return {
            games: lastGames,
            summary: {
                totalAnalyses: analyses.length,
                avgMyAccuracy: Math.round(avgMyAccuracy),
                avgAccuracyWhite: Math.round(avgWhite),
                avgAccuracyBlack: Math.round(avgBlack),
            },
            accuracyByPhase,
            moveQuality,
        };
    },

    async delete(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        const data = await _load();
        const before = data.analyses.length;

        // Eliminar archivos de datos completos asociados en paralelo
        await Promise.allSettled(
            ids.map(async (id) => {
                const entry = data.analyses.find(a => a.id === id);
                if (entry?.gameId) {
                    const fullPath = path.join(FULL_DATA_DIR, `${entry.gameId}.json`);
                    await fsp.unlink(fullPath).catch(() => { /* ya no existe */ });
                }
            })
        );

        data.analyses = data.analyses.filter(a => !ids.includes(a.id));
        await _save(data);
        return data.analyses.length < before;
    },

    async clear() {
        await _save({ analyses: [] });
    },
};

module.exports = { GameStore };
