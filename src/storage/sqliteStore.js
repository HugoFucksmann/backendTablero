'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'database.sqlite');
const DATA_DIR = path.dirname(DB_PATH);

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// ─── Schema ──────────────────────────────────────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        gameId TEXT UNIQUE,
        createdAt TEXT,
        date TEXT,
        opening TEXT,
        moveCount INTEGER,
        color TEXT,
        win INTEGER,
        timeControl TEXT,
        whiteAccuracy INTEGER,
        blackAccuracy INTEGER,
        accuracyByPhase TEXT,
        labelCounts TEXT
    );

    CREATE TABLE IF NOT EXISTS phase_accuracy (
        game_id TEXT,
        phase TEXT,
        accuracy INTEGER,
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS move_quality (
        game_id TEXT,
        label TEXT,
        count INTEGER,
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_date ON analyses(date);
    CREATE INDEX IF NOT EXISTS idx_timeControl ON analyses(timeControl);
    CREATE INDEX IF NOT EXISTS idx_phase_game ON phase_accuracy(game_id);
    CREATE INDEX IF NOT EXISTS idx_quality_game ON move_quality(game_id);
`);

const SqliteStore = {
    save(entry) {
        const insertAnalysis = db.prepare(`
            INSERT OR REPLACE INTO analyses (
                id, gameId, createdAt, date, opening, moveCount, 
                color, win, timeControl, whiteAccuracy, blackAccuracy, 
                accuracyByPhase, labelCounts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertPhase = db.prepare(`INSERT INTO phase_accuracy (game_id, phase, accuracy) VALUES (?, ?, ?)`);
        const insertQuality = db.prepare(`INSERT INTO move_quality (game_id, label, count) VALUES (?, ?, ?)`);
        const deletePhases = db.prepare(`DELETE FROM phase_accuracy WHERE game_id = ?`);
        const deleteQuality = db.prepare(`DELETE FROM move_quality WHERE game_id = ?`);

        const transaction = db.transaction((entry) => {
            insertAnalysis.run(
                entry.id,
                entry.gameId,
                entry.createdAt,
                entry.date,
                entry.opening,
                entry.moveCount,
                entry.color,
                entry.win ? 1 : 0,
                entry.timeControl,
                entry.white?.accuracy ?? null,
                entry.black?.accuracy ?? null,
                JSON.stringify(entry.accuracyByPhase || []),
                JSON.stringify(entry.labelCounts || {})
            );

            // Limpiar y re-insertar datos normalizados
            deletePhases.run(entry.id);
            if (Array.isArray(entry.accuracyByPhase)) {
                for (const { phase, accuracy } of entry.accuracyByPhase) {
                    insertPhase.run(entry.id, phase, accuracy);
                }
            }

            deleteQuality.run(entry.id);
            if (entry.labelCounts && typeof entry.labelCounts === 'object') {
                for (const [label, count] of Object.entries(entry.labelCounts)) {
                    insertQuality.run(entry.id, label, count);
                }
            }
        });

        return transaction(entry);
    },

    getAll(offset = 0, limit = 50) {
        const query = `SELECT * FROM analyses ORDER BY date DESC LIMIT ? OFFSET ?`;
        const rows = db.prepare(query).all(limit, offset);
        return rows.map(row => this._mapRow(row));
    },

    getStats(filters = {}) {
        let query = `SELECT * FROM analyses WHERE 1=1`;
        const params = [];

        if (filters.duration && filters.duration !== 'all') {
            query += ` AND timeControl = ?`;
            params.push(filters.duration);
        }

        if (filters.time && filters.time !== 'all') {
            const days = filters.time === '7d' ? 7 : 30;
            const limitDate = new Date(Date.now() - days * 86400000).toISOString();
            query += ` AND date >= ?`;
            params.push(limitDate);
        }

        query += ` ORDER BY date DESC`;

        const rows = db.prepare(query).all(...params);
        return rows.map(this._mapRow.bind(this));
    },

    getAggregatedStats(filters = {}) {
        let whereClause = "WHERE 1=1";
        const params = [];

        if (filters.duration && filters.duration !== 'all') {
            whereClause += ` AND timeControl = ?`;
            params.push(filters.duration);
        }

        if (filters.time && filters.time !== 'all') {
            const days = filters.time === '7d' ? 7 : 30;
            const limitDate = new Date(Date.now() - days * 86400000).toISOString();
            whereClause += ` AND date >= ?`;
            params.push(limitDate);
        }

        // 1. Estadísticas Generales
        const general = db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) as wins,
                AVG(CASE WHEN color = 'white' THEN whiteAccuracy ELSE blackAccuracy END) as avgAcc
            FROM analyses
            ${whereClause}
        `).get(...params);

        if (!general || general.total === 0) return { empty: true };

        // 2. Por Color
        const colorStats = db.prepare(`
            SELECT 
                color,
                COUNT(*) as count,
                AVG(CASE WHEN color = 'white' THEN whiteAccuracy ELSE blackAccuracy END) as acc,
                AVG(CASE WHEN win = 1 THEN 100.0 ELSE 0.0 END) as wr
            FROM analyses
            ${whereClause}
            GROUP BY color
        `).all(...params);

        const white = colorStats.find(c => c.color === 'white') || { count: 0, acc: 0, wr: 0 };
        const black = colorStats.find(c => c.color === 'black') || { count: 0, acc: 0, wr: 0 };

        // 3. Aperturas (Top 4)
        const openingStats = db.prepare(`
            SELECT 
                TRIM(CASE 
                    WHEN instr(opening, ':') > 0 THEN substr(opening, 1, instr(opening, ':') - 1)
                    ELSE opening 
                END) as name,
                COUNT(*) as count,
                AVG(CASE WHEN win = 1 THEN 100.0 ELSE 0.0 END) as wr,
                AVG(CASE WHEN color = 'white' THEN whiteAccuracy ELSE blackAccuracy END) as acc
            FROM analyses
            ${whereClause}
            GROUP BY name
            ORDER BY count DESC
            LIMIT 4
        `).all(...params);

        // 4. Tendencia (respeta countFilter para el gráfico)
        const trendLimit = (filters.count && filters.count !== 'all') ? parseInt(filters.count) : 25;
        const trend = db.prepare(`
            SELECT date, 
                   (CASE WHEN color = 'white' THEN whiteAccuracy ELSE blackAccuracy END) as accuracy
            FROM analyses
            ${whereClause}
            ORDER BY date DESC
            LIMIT ${trendLimit}
        `).all(...params).reverse();

        // 5. Agregación de Fases (NUEVO: SQL nativo)
        const phaseAccuracies = db.prepare(`
            SELECT 
                phase,
                ROUND(AVG(accuracy)) as accuracy
            FROM phase_accuracy
            WHERE game_id IN (SELECT id FROM analyses ${whereClause})
            GROUP BY phase
            ORDER BY CASE phase WHEN 'Apertura' THEN 1 WHEN 'Medio Juego' THEN 2 WHEN 'Final' THEN 3 END
        `).all(...params);

        const PHASE_COLORS = { 'Apertura': '#4caf50', 'Medio Juego': '#ff9800', 'Final': '#2196f3' };
        const accuracyByPhase = phaseAccuracies.map(p => ({
            ...p,
            color: PHASE_COLORS[p.phase]
        }));

        // 6. Calidad de Jugadas (NUEVO: SQL nativo)
        const LABEL_COLORS = {
            'Brillante': '#7c4dff', 'Mejor': '#4caf50', 'Excelente': '#8bc34a',
            'Bueno': '#cddc39', 'Imprecisión': '#ff9800', 'Error': '#f44336', 'Error grave': '#b71c1c'
        };
        const qualityStats = db.prepare(`
            SELECT 
                label,
                SUM(count) as totalCount
            FROM move_quality
            WHERE game_id IN (SELECT id FROM analyses ${whereClause})
            GROUP BY label
        `).all(...params);

        const totalMoves = qualityStats.reduce((sum, q) => sum + q.totalCount, 0);
        const moveQuality = ['Brillante', 'Mejor', 'Excelente', 'Bueno', 'Imprecisión', 'Error', 'Error grave']
            .map(label => {
                const stat = qualityStats.find(q => q.label === label);
                if (!stat) return null;
                return {
                    label,
                    count: stat.totalCount,
                    pct: Math.round((stat.totalCount / totalMoves) * 100),
                    color: LABEL_COLORS[label]
                };
            })
            .filter(Boolean);

        return {
            total: general.total,
            winRate: Math.round((general.wins / general.total) * 100),
            avgAcc: Math.round(general.avgAcc || 0),
            white: { count: white.count, acc: Math.round(white.acc || 0), wr: Math.round(white.wr || 0) },
            black: { count: black.count, acc: Math.round(black.acc || 0), wr: Math.round(black.wr || 0) },
            openingStats: openingStats.map(o => ({ ...o, wr: Math.round(o.wr), acc: Math.round(o.acc) })),
            trend,
            accuracyByPhase,
            moveQuality
        };
    },

    delete(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        const stmt = db.prepare(`DELETE FROM analyses WHERE id = ?`);
        const transaction = db.transaction((ids) => {
            for (const id of ids) stmt.run(id);
        });
        transaction(ids);
    },

    _mapRow(row) {
        return {
            ...row,
            win: !!row.win,
            white: { accuracy: row.whiteAccuracy },
            black: { accuracy: row.blackAccuracy },
            accuracyByPhase: JSON.parse(row.accuracyByPhase || '[]'),
            labelCounts: JSON.parse(row.labelCounts || '{}')
        };
    },

    count() {
        return db.prepare('SELECT COUNT(*) as total FROM analyses').get().total;
    },

    clear() {
        db.prepare('DELETE FROM analyses').run();
        db.prepare('DELETE FROM phase_accuracy').run();
        db.prepare('DELETE FROM move_quality').run();
    }
};

module.exports = { SqliteStore };
