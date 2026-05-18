'use strict';

const db = require('../db');

// ─── Constants ────────────────────────────────────────────────────────────────

const PHASE_ORDER = { 'Apertura': 1, 'Medio Juego': 2, 'Final': 3 };

const PHASE_COLORS = {
    'Apertura': '#4caf50',
    'Medio Juego': '#ff9800',
    'Final': '#2196f3',
};

const LABEL_COLORS = {
    'Brillante': '#7c4dff',
    'Mejor': '#4caf50',
    'Excelente': '#8bc34a',
    'Bueno': '#cddc39',
    'Imprecisión': '#ff9800',
    'Error': '#f44336',
    'Error grave': '#b71c1c',
    'Insta-move Blunder': '#f44336',
    'Deep-think Blunder': '#b71c1c',
    'Time Pressure Error': '#ff5722',
};

const MOVE_QUALITY_ORDER = [
    'Brillante', 'Mejor', 'Excelente', 'Bueno',
    'Imprecisión', 'Error', 'Error grave',
    'Insta-move Blunder', 'Deep-think Blunder', 'Time Pressure Error',
];

const BLUNDER_LABELS = [
    'Insta-move Blunder',
    'Deep-think Blunder',
    'Time Pressure Error',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a WHERE clause and its parameter list from a filters object.
 * @param {object} filters
 * @returns {{ clause: string, params: any[] }}
 */
function buildWhereClause(filters = {}) {
    let clause = 'WHERE 1=1';
    const params = [];

    if (filters.username) {
        clause += ' AND (username = ? OR username IS NULL)';
        params.push(filters.username);
    }
    if (filters.duration && filters.duration !== 'all') {
        // timeControl is stored as "600+5" (seconds+increment) or "10m" etc.
        // Map the UI values ("1m", "3m"...) to second ranges.
        const durationMap = {
            '1m':  [0,    90],    // bullet: <90s
            '3m':  [90,   240],   // blitz 3m: 90-240s
            '5m':  [240,  420],   // blitz 5m: 240-420s
            '10m': [420,  900],   // rapid 10m
            '15m': [900,  1200],  // rapid 15m
            '30m': [1200, 99999], // classical
        };
        const range = durationMap[filters.duration];
        if (range) {
            // Extract initial seconds: CAST(SUBSTR(timeControl, 1, INSTR(timeControl||'+', '+')-1) AS INTEGER)
            clause += ` AND CAST(SUBSTR(COALESCE(timeControl,'0'), 1,
                MAX(1, INSTR(COALESCE(timeControl,'0')||'+', '+') - 1)) AS INTEGER) BETWEEN ? AND ?`;
            params.push(range[0], range[1]);
        }
    }
    if (filters.time && filters.time !== 'all') {
        const days = parseInt(filters.time) || 30;
        const limitDate = new Date(Date.now() - days * 86400000).toISOString();
        // Use gameDate (real match date) when available, fallback to analysis date
        clause += ' AND COALESCE(gameDate, date) >= ?';
        params.push(limitDate);
    }

    return { clause, params };
}

/**
 * Builds the SQL fragments used to scope all sub-queries to the same filtered set.
 * @param {string}  whereClause
 * @param {any[]}   params
 * @param {number|null} limit
 * @returns {{ idListClause: string, gameIdListClause: string }}
 */
function buildScopeFragments(whereClause, params, limit) {
    const limitSql = limit ? `LIMIT ${limit}` : '';
    const subQuery = `SELECT id FROM analyses ${whereClause} ORDER BY COALESCE(gameDate, date) DESC ${limitSql}`;
    return {
        idListClause: `WHERE id      IN (${subQuery})`,
        gameIdListClause: `WHERE game_id IN (${subQuery})`,
    };
}

// ─── Repository ───────────────────────────────────────────────────────────────

const StatsRepo = {

    /**
     * Returns a comprehensive aggregated statistics object for a filtered set of games.
     * @param {object} filters  - { username, duration, time, count }
     * @returns {object}
     */
    getAggregatedStats(filters = {}) {
        const { clause, params } = buildWhereClause(filters);
        const limit = (filters.count && filters.count !== 'all') ? parseInt(filters.count) : null;
        const { idListClause, gameIdListClause } = buildScopeFragments(clause, params, limit);

        // ── 1. General ────────────────────────────────────────────────────────

        const general = db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN win = 1  THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN win = 0  THEN 1 ELSE 0 END) as draws,
                AVG(CASE
                    WHEN color = 'white' AND whiteAccuracy IS NOT NULL THEN whiteAccuracy
                    WHEN color = 'black' AND blackAccuracy IS NOT NULL THEN blackAccuracy
                    ELSE COALESCE(whiteAccuracy, blackAccuracy, 0)
                END) as avgAcc
            FROM analyses
            ${idListClause}
        `).get(...params);

        if (!general || general.total === 0) return { empty: true };

        // ── 2. By color ───────────────────────────────────────────────────────

        const colorRows = db.prepare(`
            SELECT
                color,
                COUNT(*) as count,
                AVG(CASE
                    WHEN color = 'white' THEN COALESCE(whiteAccuracy, blackAccuracy)
                    ELSE COALESCE(blackAccuracy, whiteAccuracy)
                END) as acc,
                AVG(CASE WHEN win = 1  THEN 100.0 ELSE 0.0 END) as wr,
                AVG(CASE WHEN win = 0  THEN 100.0 ELSE 0.0 END) as dr
            FROM analyses
            ${idListClause}
            GROUP BY color
        `).all(...params);

        const white = colorRows.find(c => c.color === 'white') || { count: 0, acc: 0, wr: 0 };
        const black = colorRows.find(c => c.color === 'black') || { count: 0, acc: 0, wr: 0 };

        // ── 3. Openings ───────────────────────────────────────────────────────
        //      Aggressive variant grouping: strip everything after ':', ' - ', or ', '

        const openingStats = db.prepare(`
            SELECT
                TRIM(CASE
                    WHEN instr(opening, ':')   > 0 THEN substr(opening, 1, instr(opening, ':')   - 1)
                    WHEN instr(opening, ' - ') > 0 THEN substr(opening, 1, instr(opening, ' - ') - 1)
                    WHEN instr(opening, ', ')  > 0 THEN substr(opening, 1, instr(opening, ', ')  - 1)
                    ELSE opening
                END) as name,
                COUNT(*) as count,
                AVG(CASE WHEN win = 1 THEN 100.0 ELSE 0.0 END) as wr,
                AVG(CASE
                    WHEN color = 'white' THEN COALESCE(whiteAccuracy, blackAccuracy)
                    ELSE COALESCE(blackAccuracy, whiteAccuracy)
                END) as acc
            FROM analyses
            ${idListClause}
            GROUP BY name
            ORDER BY count DESC
            LIMIT 10
        `).all(...params);

        // ── 4. Accuracy trend ─────────────────────────────────────────────────

        const trend = db.prepare(`
            SELECT
                date,
                (CASE WHEN color = 'white' THEN whiteAccuracy ELSE blackAccuracy END) as accuracy
            FROM analyses
            ${idListClause}
            ORDER BY date DESC
        `).all(...params).reverse();

        // ── 5. Phase accuracy ─────────────────────────────────────────────────

        const phaseRows = db.prepare(`
            SELECT
                phase,
                ROUND(AVG(accuracy)) as accuracy
            FROM phase_accuracy
            ${gameIdListClause}
            GROUP BY phase
            ORDER BY CASE phase
                WHEN 'Apertura'    THEN 1
                WHEN 'Medio Juego' THEN 2
                WHEN 'Final'       THEN 3
            END
        `).all(...params);

        const accuracyByPhase = phaseRows.map(p => ({
            ...p,
            color: PHASE_COLORS[p.phase],
        }));

        // ── 6. Move quality ───────────────────────────────────────────────────

        const qualityRows = db.prepare(`
            SELECT label, SUM(count) as totalCount
            FROM move_quality
            ${gameIdListClause}
            GROUP BY label
        `).all(...params);

        const totalMoves = qualityRows.reduce((sum, q) => sum + q.totalCount, 0);

        const moveQuality = MOVE_QUALITY_ORDER
            .map(label => {
                const stat = qualityRows.find(q => q.label === label);
                if (!stat) return null;
                return {
                    label,
                    count: stat.totalCount,
                    pct: Math.round((stat.totalCount / totalMoves) * 100),
                    color: LABEL_COLORS[label],
                };
            })
            .filter(Boolean);

        // ── 7. Blunders by think time ─────────────────────────────────────────

        const blunderRows = db.prepare(`
            SELECT label, COUNT(*) as count
            FROM game_moves
            ${gameIdListClause}
            AND label IN ('Insta-move Blunder', 'Deep-think Blunder', 'Time Pressure Error')
            GROUP BY label
        `).all(...params);

        const blundersByTime = [
            { label: 'Insta-move', dbLabel: 'Insta-move Blunder', color: '#f44336' },
            { label: 'Deep-think', dbLabel: 'Deep-think Blunder', color: '#b71c1c' },
            { label: 'Time Pressure', dbLabel: 'Time Pressure Error', color: '#ff5722' },
        ]
            .map(b => ({ label: b.label, color: b.color, count: blunderRows.find(r => r.label === b.dbLabel)?.count || 0 }))
            .filter(b => b.count > 0);

        // ── 8. Dangerous openings ─────────────────────────────────────────────

        const dangerousOpenings = db.prepare(`
            SELECT
                a.eco,
                TRIM(CASE
                    WHEN instr(a.opening, ':')   > 0 THEN substr(a.opening, 1, instr(a.opening, ':')   - 1)
                    WHEN instr(a.opening, ' - ') > 0 THEN substr(a.opening, 1, instr(a.opening, ' - ') - 1)
                    WHEN instr(a.opening, ', ')  > 0 THEN substr(a.opening, 1, instr(a.opening, ', ')  - 1)
                    ELSE a.opening
                END) as name,
                COUNT(m.game_id) * 1.0 / COUNT(DISTINCT a.id) as errorsPerGame,
                COUNT(DISTINCT a.id) as gameCount
            FROM analyses a
            LEFT JOIN game_moves m
                ON  a.id = m.game_id
                AND m.label IN ('Error grave', 'Error', 'Deep-think Blunder', 'Insta-move Blunder', 'Time Pressure Error')
            ${idListClause.replace('id IN', 'a.id IN')}
            GROUP BY name
            HAVING gameCount >= 1
            ORDER BY errorsPerGame DESC
            LIMIT 3
        `).all(...params);

        // ── 9. Advanced metrics ───────────────────────────────────────────────

        const metricsRows = db.prepare(`
            SELECT advancedMetrics
            FROM analyses
            ${idListClause}
            AND advancedMetrics IS NOT NULL AND advancedMetrics != '{}'
        `).all(...params);

        const acc = {
            convertedAdvantages: 0, blownAdvantages: 0,
            comebackWins: 0, savedDraws: 0, failedComebacks: 0,
            tiltEvents: 0,
            totalMidgameTime: 0, totalBlunderTime: 0, gamesWithTime: 0,
        };

        for (const row of metricsRows) {
            try {
                const am = JSON.parse(row.advancedMetrics);

                if (am.advantageStatus === 'CONVERTED') acc.convertedAdvantages++;
                if (am.advantageStatus === 'BLOWN_ADVANTAGE') acc.blownAdvantages++;
                if (am.comebackStatus === 'COMEBACK_WIN') acc.comebackWins++;
                if (am.comebackStatus === 'SAVED_DRAW') acc.savedDraws++;
                if (am.comebackStatus === 'FAILED') acc.failedComebacks++;
                if (am.tiltEvents) acc.tiltEvents += am.tiltEvents;

                if (am.timeManagement) {
                    acc.totalMidgameTime += am.timeManagement.avgMidgameTime || 0;
                    acc.totalBlunderTime += am.timeManagement.avgBlunderTime || 0;
                    if (am.timeManagement.avgMidgameTime > 0) acc.gamesWithTime++;
                }
            } catch (_) { /* malformed row — skip */ }
        }

        // ── Return ────────────────────────────────────────────────────────────

        return {
            total: general.total,
            winRate: Math.round((general.wins / general.total) * 100),
            drawRate: Math.round((general.draws / general.total) * 100),
            avgAcc: Math.round(general.avgAcc || 0),

            white: { count: white.count, acc: Math.round(white.acc || 0), wr: Math.round(white.wr || 0) },
            black: { count: black.count, acc: Math.round(black.acc || 0), wr: Math.round(black.wr || 0) },

            openingStats: openingStats.map(o => ({ ...o, wr: Math.round(o.wr), acc: Math.round(o.acc) })),
            trend,
            accuracyByPhase,
            moveQuality,
            blundersByTime,
            dangerousOpenings,

            advancedStats: {
                ...acc,
                avgMidgameTime: acc.gamesWithTime > 0 ? acc.totalMidgameTime / acc.gamesWithTime : 0,
                avgBlunderTime: acc.gamesWithTime > 0 ? acc.totalBlunderTime / acc.gamesWithTime : 0,
            },
        };
    },

    /**
     * Returns individual FEN positions for a given metric category (tilt, comeback, blown_advantage).
     * @param {'tilt'|'comeback'|'blown_advantage'} category
     * @param {object} filters
     * @returns {object[]}
     */
    getStatDetails(category, filters = {}) {
        const VALID_CATEGORIES = ['tilt', 'comeback', 'blown_advantage'];
        if (!VALID_CATEGORIES.includes(category)) return [];

        const { clause, params } = buildWhereClause(filters);
        const limit = (filters.count && filters.count !== 'all') ? parseInt(filters.count) : null;
        const { idListClause } = buildScopeFragments(clause, params, limit);

        const rows = db.prepare(`
            SELECT a.id, a.gameId, a.win, a.color, a.advancedMetrics, a.date, a.gameDate, a.opening, a.eco, f.full_json
            FROM analyses a
            LEFT JOIN analysis_full_data f ON f.game_id = a.gameId
            ${idListClause.replace('id IN', 'a.id IN')}
            AND a.advancedMetrics IS NOT NULL
        `).all(...params);

        // Looks up the FEN stored after a move (position after ply N).
        const fenByPly = db.prepare(`SELECT fen FROM game_moves WHERE game_id = ? AND ply = ?`);

        const CATEGORY_FEN_KEY = {
            tilt: 'tiltFens',
            comeback: 'comebackFens',
            blown_advantage: 'blownAdvantageFens',
        };

        const results = [];

        for (const row of rows) {
            try {
                const am = JSON.parse(row.advancedMetrics);
                const items = am[CATEGORY_FEN_KEY[category]];
                if (!items) continue;

                for (const item of items) {
                    const ply = typeof item === 'string' ? null : (item.ply ?? null);

                    // Prefer the FEN stored in game_moves (more accurate);
                    // fall back to the one embedded in advancedMetrics for legacy data.
                    let fen = typeof item === 'string' ? item : item.fen;
                    if (ply !== null) {
                        const fenRow = fenByPly.get(row.id, ply);
                        if (fenRow?.fen) fen = fenRow.fen;
                    }

                    if (fen && typeof fen === 'string' && fen.trim()) {
                        let opponent = 'Desconocido';
                        if (row.full_json) {
                            try {
                                const gameData = JSON.parse(row.full_json);
                                const headers = gameData.gameHeaders || {};
                                opponent = row.color === 'white' ? (headers.Black || 'Desconocido') : (headers.White || 'Desconocido');
                            } catch (e) {}
                        }

                        results.push({
                            gameId: row.gameId,
                            analysisId: row.id,
                            fen: fen.trim(),
                            ply,
                            type: category,
                            win: row.win,
                            color: row.color,
                            opponent,
                            date: row.gameDate || row.date,
                            opening: row.opening,
                            eco: row.eco
                        });
                    }
                }
            } catch (_) { /* malformed advancedMetrics — skip */ }
        }

        return results;
    },

    /**
     * Returns move frequency and outcome statistics for a given board position.
     * Normalizes the FEN to 3 parts (piece placement + active color + castling)
     * to handle transpositions and en-passant field differences.
     *
     * @param {string} fen
     * @returns {object}
     */
    getMoveExplorer(fen) {
        const normalizedFen = fen.split(' ').slice(0, 3).join(' ');

        const rows = db.prepare(`
            SELECT
                m.move_san,
                a.color  as userColor,
                m.start_fen,
                a.win,
                m.evaluation,
                m.label,
                m.move_time
            FROM game_moves m
            JOIN analyses a ON m.game_id = a.id
            WHERE m.start_fen GLOB ?
        `).all(`${normalizedFen} *`);
        // GLOB is case-sensitive (required for FEN) and uses prefix matching.
        // The trailing space + wildcard ensures the castling field is matched exactly
        // (e.g. "KQ" does not match "KQkq").

        const stats = {
            whitePerspective: { user: {}, opponent: {} },
            blackPerspective: { user: {}, opponent: {} },
        };

        for (const row of rows) {
            const isWhiteMove = row.start_fen.includes(' w ');
            const perspective = row.userColor === 'white' ? stats.whitePerspective : stats.blackPerspective;
            const isUserMove = (row.userColor === 'white' && isWhiteMove) || (row.userColor === 'black' && !isWhiteMove);
            const target = isUserMove ? perspective.user : perspective.opponent;

            if (!target[row.move_san]) {
                target[row.move_san] = {
                    san: row.move_san, count: 0,
                    wins: 0, draws: 0, losses: 0,
                    totalEval: 0, evalCount: 0,
                    labels: {},
                };
            }

            const s = target[row.move_san];
            s.count++;

            if (row.win === 1) s.wins++;
            else if (row.win === 0) s.draws++;
            else if (row.win === -1) s.losses++;

            if (row.evaluation != null) {
                s.totalEval += row.evaluation;
                s.evalCount += 1;
            }

            if (row.label) {
                s.labels[row.label] = (s.labels[row.label] || 0) + 1;
            }
        }

        const formatSide = (sideData) =>
            Object.values(sideData)
                .map(s => ({
                    san: s.san,
                    count: s.count,
                    winRate: Math.round((s.wins / s.count) * 100),
                    drawRate: Math.round((s.draws / s.count) * 100),
                    lossRate: Math.round((s.losses / s.count) * 100),
                    avgEval: s.evalCount > 0 ? (s.totalEval / s.evalCount).toFixed(2) : null,
                    labels: s.labels,
                }))
                .sort((a, b) => b.count - a.count);

        return {
            whitePerspective: {
                userMoves: formatSide(stats.whitePerspective.user),
                opponentMoves: formatSide(stats.whitePerspective.opponent),
            },
            blackPerspective: {
                userMoves: formatSide(stats.blackPerspective.user),
                opponentMoves: formatSide(stats.blackPerspective.opponent),
            },
        };
    },
};

module.exports = StatsRepo;