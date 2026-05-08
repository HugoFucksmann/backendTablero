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
        username TEXT,
        createdAt TEXT,
        date TEXT,
        opening TEXT,
        eco TEXT,
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

    CREATE TABLE IF NOT EXISTS game_moves (
        game_id TEXT,
        ply INTEGER,
        move_san TEXT,
        evaluation REAL,
        label TEXT,
        move_time INTEGER,
        remaining_time INTEGER,
        fen TEXT,
        PRIMARY KEY (game_id, ply),
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_date ON analyses(date);
    CREATE INDEX IF NOT EXISTS idx_timeControl ON analyses(timeControl);
    CREATE INDEX IF NOT EXISTS idx_phase_game ON phase_accuracy(game_id);
    CREATE INDEX IF NOT EXISTS idx_quality_game ON move_quality(game_id);
    CREATE INDEX IF NOT EXISTS idx_moves_game ON game_moves(game_id);
    CREATE INDEX IF NOT EXISTS idx_moves_label ON game_moves(label);
    CREATE INDEX IF NOT EXISTS idx_moves_fen ON game_moves(fen);
`);

// Migraciones rápidas para bases existentes
try { db.exec("ALTER TABLE analyses ADD COLUMN eco TEXT;"); } catch(e) {}
try { db.exec("ALTER TABLE analyses ADD COLUMN username TEXT;"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_username ON analyses(username);"); } catch(e) {}



const SqliteStore = {
    save(entry) {
        const insertAnalysis = db.prepare(`
            INSERT OR REPLACE INTO analyses (
                id, gameId, username, createdAt, date, opening, eco, moveCount, 
                color, win, timeControl, whiteAccuracy, blackAccuracy, 
                accuracyByPhase, labelCounts
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);


        const insertPhase = db.prepare(`INSERT INTO phase_accuracy (game_id, phase, accuracy) VALUES (?, ?, ?)`);
        const insertQuality = db.prepare(`INSERT INTO move_quality (game_id, label, count) VALUES (?, ?, ?)`);
        const insertMove = db.prepare(`INSERT INTO game_moves (game_id, ply, move_san, evaluation, label, move_time, remaining_time, fen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        
        const deletePhases = db.prepare(`DELETE FROM phase_accuracy WHERE game_id = ?`);
        const deleteQuality = db.prepare(`DELETE FROM move_quality WHERE game_id = ?`);
        const deleteMoves = db.prepare(`DELETE FROM game_moves WHERE game_id = ?`);

        const transaction = db.transaction((entry) => {
            insertAnalysis.run(
                entry.id,
                entry.gameId,
                entry.username || null,
                entry.createdAt,
                entry.date,
                entry.opening,
                entry.eco || null,
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

            deleteMoves.run(entry.id);
            if (Array.isArray(entry.moves)) {
                for (const move of entry.moves) {
                    insertMove.run(
                        entry.id,
                        move.ply,
                        move.san,
                        move.evaluation,
                        move.label,
                        move.moveTime || null,
                        move.remainingTime || null,
                        move.fen
                    );
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
        return rows.map(row => this._mapRow(row));
    },

    getAggregatedStats(filters = {}) {
        let whereClause = "WHERE 1=1";
        const params = [];

        if (filters.username) {
            whereClause += ` AND (username = ? OR username IS NULL)`;
            params.push(filters.username);
        }


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

        // 1. Estadísticas Generales (Mejorada la precisión para evitar 0.0)
        const general = db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) as wins,
                AVG(CASE 
                    WHEN color = 'white' AND whiteAccuracy IS NOT NULL THEN whiteAccuracy
                    WHEN color = 'black' AND blackAccuracy IS NOT NULL THEN blackAccuracy
                    ELSE COALESCE(whiteAccuracy, blackAccuracy, 0)
                END) as avgAcc
            FROM analyses
            ${whereClause}
        `).get(...params);

        if (!general || general.total === 0) return { empty: true };

        // 2. Por Color
        const colorStats = db.prepare(`
            SELECT 
                color,
                COUNT(*) as count,
                AVG(CASE 
                    WHEN color = 'white' THEN COALESCE(whiteAccuracy, blackAccuracy) 
                    ELSE COALESCE(blackAccuracy, whiteAccuracy) 
                END) as acc,
                AVG(CASE WHEN win = 1 THEN 100.0 ELSE 0.0 END) as wr
            FROM analyses

            ${whereClause}
            GROUP BY color
        `).all(...params);

        const white = colorStats.find(c => c.color === 'white') || { count: 0, acc: 0, wr: 0 };
        const black = colorStats.find(c => c.color === 'black') || { count: 0, acc: 0, wr: 0 };

        // 3. Aperturas (Agrupación agresiva de variantes)
        const openingStats = db.prepare(`
            SELECT 
                TRIM(CASE 
                    WHEN instr(opening, ':') > 0 THEN substr(opening, 1, instr(opening, ':') - 1)
                    WHEN instr(opening, ' - ') > 0 THEN substr(opening, 1, instr(opening, ' - ') - 1)
                    WHEN instr(opening, ', ') > 0 THEN substr(opening, 1, instr(opening, ', ') - 1)
                    ELSE opening 
                END) as name,
                COUNT(*) as count,
                AVG(CASE WHEN win = 1 THEN 100.0 ELSE 0.0 END) as wr,
                AVG(CASE 
                    WHEN color = 'white' THEN COALESCE(whiteAccuracy, blackAccuracy) 
                    ELSE COALESCE(blackAccuracy, whiteAccuracy) 
                END) as acc
            FROM analyses

            ${whereClause}
            GROUP BY name
            ORDER BY count DESC
            LIMIT 10
        `).all(...params);

        // 4. Tendencia
        const trendLimit = (filters.count && filters.count !== 'all') ? parseInt(filters.count) : 25;
        const trend = db.prepare(`
            SELECT date, 
                   (CASE WHEN color = 'white' THEN whiteAccuracy ELSE blackAccuracy END) as accuracy
            FROM analyses
            ${whereClause}
            ORDER BY date DESC
            LIMIT ${trendLimit}
        `).all(...params).reverse();

        // 5. Agregación de Fases
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

        // 6. Calidad de Jugadas
        const LABEL_COLORS = {
            'Brillante': '#7c4dff', 'Mejor': '#4caf50', 'Excelente': '#8bc34a',
            'Bueno': '#cddc39', 'Imprecisión': '#ff9800', 'Error': '#f44336', 'Error grave': '#b71c1c',
            'Insta-move Blunder': '#f44336', 'Deep-think Blunder': '#b71c1c', 'Time Pressure Error': '#ff5722'
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
        const moveQuality = ['Brillante', 'Mejor', 'Excelente', 'Bueno', 'Imprecisión', 'Error', 'Error grave', 'Insta-move Blunder', 'Deep-think Blunder', 'Time Pressure Error']
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

        // 7. Desglose de Errores por Tiempo
        const timeBlunderStats = db.prepare(`
            SELECT 
                label,
                COUNT(*) as count
            FROM game_moves
            WHERE game_id IN (SELECT id FROM analyses ${whereClause})
            AND label IN ('Insta-move Blunder', 'Deep-think Blunder', 'Time Pressure Error')
            GROUP BY label
        `).all(...params);

        const blundersByTime = [
            { label: 'Insta-move', count: timeBlunderStats.find(s => s.label === 'Insta-move Blunder')?.count || 0, color: '#f44336' },
            { label: 'Deep-think', count: timeBlunderStats.find(s => s.label === 'Deep-think Blunder')?.count || 0, color: '#b71c1c' },
            { label: 'Time Pressure', count: timeBlunderStats.find(s => s.label === 'Time Pressure Error')?.count || 0, color: '#ff5722' }
        ].filter(b => b.count > 0);

        // 8. Aperturas Peligrosas (Agrupación mejorada)
        const dangerousOpenings = db.prepare(`
            SELECT 
                a.eco,
                TRIM(CASE 
                    WHEN instr(a.opening, ':') > 0 THEN substr(a.opening, 1, instr(a.opening, ':') - 1)
                    WHEN instr(a.opening, ' - ') > 0 THEN substr(a.opening, 1, instr(a.opening, ' - ') - 1)
                    WHEN instr(a.opening, ', ') > 0 THEN substr(a.opening, 1, instr(a.opening, ', ') - 1)
                    ELSE a.opening 
                END) as name,
                COUNT(m.game_id) * 1.0 / COUNT(DISTINCT a.id) as errorsPerGame,
                COUNT(DISTINCT a.id) as gameCount
            FROM analyses a
            LEFT JOIN game_moves m ON a.id = m.game_id AND m.label IN ('Error grave', 'Error', 'Deep-think Blunder', 'Insta-move Blunder', 'Time Pressure Error')
            WHERE a.id IN (SELECT id FROM analyses ${whereClause})
            GROUP BY name
            HAVING gameCount >= 1
            ORDER BY errorsPerGame DESC
            LIMIT 3
        `).all(...params);

        return {
            total: general.total,
            winRate: Math.round((general.wins / general.total) * 100),
            avgAcc: Math.round(general.avgAcc || 0),
            white: { count: white.count, acc: Math.round(white.acc || 0), wr: Math.round(white.wr || 0) },
            black: { count: black.count, acc: Math.round(black.acc || 0), wr: Math.round(black.wr || 0) },
            openingStats: openingStats.map(o => ({ ...o, wr: Math.round(o.wr), acc: Math.round(o.acc) })),
            trend,
            accuracyByPhase,
            moveQuality,
            blundersByTime,
            dangerousOpenings
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
