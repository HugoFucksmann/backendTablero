'use strict';

const db = require('../db');

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
    insertAnalysis: db.prepare(`
        INSERT OR REPLACE INTO analyses (
            id, gameId, username, createdAt, date, opening, eco, moveCount,
            color, win, timeControl, whiteAccuracy, blackAccuracy,
            accuracyByPhase, labelCounts, advancedMetrics, opponent, gameDate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    insertPhase: db.prepare(`INSERT INTO phase_accuracy (game_id, phase, accuracy) VALUES (?, ?, ?)`),
    insertQuality: db.prepare(`INSERT INTO move_quality (game_id, label, count) VALUES (?, ?, ?)`),
    insertMove: db.prepare(`INSERT OR REPLACE INTO game_moves (game_id, ply, move_san, evaluation, label, move_time, remaining_time, fen, start_fen, error_time_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFullData: db.prepare(`INSERT OR REPLACE INTO analysis_full_data (game_id, full_json) VALUES (?, ?)`),

    deletePhases: db.prepare(`DELETE FROM phase_accuracy  WHERE game_id = ?`),
    deleteQuality: db.prepare(`DELETE FROM move_quality    WHERE game_id = ?`),
    deleteMoves: db.prepare(`DELETE FROM game_moves      WHERE game_id = ?`),
    deleteAnalysis: db.prepare(`DELETE FROM analyses        WHERE id = ?`),

    findByGameId: db.prepare(`SELECT * FROM analyses WHERE gameId = ?`),
    findById: db.prepare(`SELECT * FROM analyses WHERE id = ?`),
    // Order by gameDate (real match date) with fallback to date (analysis date) for old records
    findAll: db.prepare(`SELECT * FROM analyses ORDER BY COALESCE(gameDate, date) DESC LIMIT ? OFFSET ?`),
    findFullData: db.prepare(`SELECT full_json FROM analysis_full_data WHERE game_id = ?`),

    // Lightweight query — only gameIds, no LIMIT. Used for the "analyzed" badge in GameImport.
    findAllGameIds: db.prepare(`SELECT gameId FROM analyses`),

    count: db.prepare(`SELECT COUNT(*) as total FROM analyses`),

    clearAnalyses: db.prepare(`DELETE FROM analyses`),
    clearPhases: db.prepare(`DELETE FROM phase_accuracy`),
    clearQuality: db.prepare(`DELETE FROM move_quality`),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deserializes a raw SQLite row into a structured analysis object.
 * @param {object} row
 * @returns {object}
 */
function mapRow(row) {
    return {
        ...row,
        // win is stored as INTEGER: 1=win, 0=draw, -1=loss
        // !!row.win would map -1 (loss) to true — BUG. Use explicit comparison.
        win: row.win === 1 ? 1 : (row.win === 0 ? 0 : -1),
        white: { accuracy: row.whiteAccuracy },
        black: { accuracy: row.blackAccuracy },
        accuracyByPhase: JSON.parse(row.accuracyByPhase || '[]'),
        labelCounts: JSON.parse(row.labelCounts || '{}'),
        advancedMetrics: JSON.parse(row.advancedMetrics || '{}'),
    };
}

// ─── Repository ───────────────────────────────────────────────────────────────

const AnalysisRepo = {

    /**
     * Persists a full analysis entry, replacing all related rows atomically.
     * @param {object} entry  - Structured analysis object (must include `.id`).
     */
    save(entry) {
        const transaction = db.transaction((entry) => {
            stmts.insertAnalysis.run(
                entry.id,
                entry.gameId,
                entry.username ?? null,
                entry.createdAt,
                entry.date,
                entry.opening,
                entry.eco ?? null,
                entry.moveCount,
                entry.color,
                entry.win,           // 1: Win | 0: Draw | -1: Loss
                entry.timeControl,
                entry.white?.accuracy ?? null,
                entry.black?.accuracy ?? null,
                JSON.stringify(entry.accuracyByPhase || []),
                JSON.stringify(entry.labelCounts || {}),
                JSON.stringify(entry.advancedMetrics || {}),
                entry.opponent ?? null,
                entry.gameDate ?? null,
            );

            // Replace normalized sub-tables
            stmts.deletePhases.run(entry.id);
            if (Array.isArray(entry.accuracyByPhase)) {
                for (const { phase, accuracy } of entry.accuracyByPhase) {
                    stmts.insertPhase.run(entry.id, phase, accuracy);
                }
            }

            stmts.deleteQuality.run(entry.id);
            if (entry.labelCounts && typeof entry.labelCounts === 'object') {
                for (const [label, count] of Object.entries(entry.labelCounts)) {
                    stmts.insertQuality.run(entry.id, label, count);
                }
            }

            stmts.deleteMoves.run(entry.id);
            if (Array.isArray(entry.moves)) {
                for (const move of entry.moves) {
                    stmts.insertMove.run(
                        entry.id,
                        move.ply,
                        move.san,
                        move.evaluation,
                        move.label,
                        move.moveTime ?? null,
                        move.remaining_time ?? null,
                        move.fen,
                        move.start_fen,
                        move.error_time_class ?? null,
                    );
                }
            }

            if (entry.fullData) {
                stmts.insertFullData.run(entry.gameId, JSON.stringify(entry.fullData));
            }
        });

        transaction(entry);
    },

    /**
     * Returns a single analysis by its chess.com / lichess game ID.
     * @param {string} gameId
     * @returns {object|null}
     */
    findByGameId(gameId) {
        const row = stmts.findByGameId.get(gameId);
        return row ? mapRow(row) : null;
    },

    /**
     * Returns a paginated list of analyses ordered by date descending.
     * @param {number} offset
     * @param {number} limit
     * @returns {object[]}
     */
    findAll(offset = 0, limit = 50) {
        return stmts.findAll.all(limit, offset).map(mapRow);
    },

    /**
     * Returns the full raw JSON blob stored for a game.
     * @param {string} gameId
     * @returns {object|null}
     */
    findFullData(gameId) {
        const row = stmts.findFullData.get(gameId);
        if (!row?.full_json) return null;

        try {
            return JSON.parse(row.full_json);
        } catch (e) {
            console.error('[AnalysisRepo] Failed to parse full_json for gameId:', gameId, e);
            return null;
        }
    },

    /**
     * Deletes one or more analyses by their internal UUID.
     * Cascades automatically to all related tables.
     * @param {string|string[]} ids
     */
    delete(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        const transaction = db.transaction((ids) => {
            for (const id of ids) stmts.deleteAnalysis.run(id);
        });
        transaction(ids);
    },

    /**
     * Deletes all analyses and their normalized sub-table data.
     */
    clear() {
        stmts.clearAnalyses.run();
        stmts.clearPhases.run();
        stmts.clearQuality.run();
    },

    /**
     * Returns all gameIds (platform IDs) of stored analyses — no LIMIT.
     * Much lighter than findAll; used solely to build the "analyzed" badge set.
     * @returns {string[]}
     */
    findAllGameIds() {
        return stmts.findAllGameIds.all().map(r => r.gameId);
    },

    /**
     * Returns the total number of stored analyses.
     * @returns {number}
     */
    count() {
        return stmts.count.get().total;
    },
};

module.exports = AnalysisRepo;