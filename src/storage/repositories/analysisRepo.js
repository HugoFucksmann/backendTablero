'use strict';

const db = require('../db');

const stmts = {
    insertAnalysis: db.prepare(`
        INSERT OR REPLACE INTO analyses (
            id, gameId, username, createdAt, date, opening, eco, moveCount,
            color, win, timeControl, whiteAccuracy, blackAccuracy,
            accuracyByPhase, labelCounts, advancedMetrics
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertPhase: db.prepare(`INSERT INTO phase_accuracy (game_id, phase, accuracy) VALUES (?, ?, ?)`),
    insertQuality: db.prepare(`INSERT INTO move_quality (game_id, label, count) VALUES (?, ?, ?)`),
    insertMove: db.prepare(`INSERT INTO game_moves (game_id, ply, move_san, evaluation, label, move_time, remaining_time, fen, start_fen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertFullData: db.prepare(`INSERT OR REPLACE INTO analysis_full_data (game_id, full_json) VALUES (?, ?)`),

    deletePhases: db.prepare(`DELETE FROM phase_accuracy WHERE game_id = ?`),
    deleteQuality: db.prepare(`DELETE FROM move_quality WHERE game_id = ?`),
    deleteMoves: db.prepare(`DELETE FROM game_moves WHERE game_id = ?`),

    // [FIX] Borra el JSON gigante relacionando el UUID interno con el gameId de ajedrez
    deleteFullData: db.prepare(`DELETE FROM analysis_full_data WHERE game_id = (SELECT gameId FROM analyses WHERE id = ?)`),
    deleteAnalysis: db.prepare(`DELETE FROM analyses WHERE id = ?`),

    findByGameId: db.prepare(`SELECT * FROM analyses WHERE gameId = ?`),
    findById: db.prepare(`SELECT * FROM analyses WHERE id = ?`),
    findAll: db.prepare(`SELECT * FROM analyses ORDER BY date DESC LIMIT ? OFFSET ?`),
    findFullData: db.prepare(`SELECT full_json FROM analysis_full_data WHERE game_id = ?`),

    count: db.prepare(`SELECT COUNT(*) as total FROM analyses`),

    clearAnalyses: db.prepare(`DELETE FROM analyses`),
    clearPhases: db.prepare(`DELETE FROM phase_accuracy`),
    clearQuality: db.prepare(`DELETE FROM move_quality`),
    clearFullData: db.prepare(`DELETE FROM analysis_full_data`),
};

function mapRow(row) {
    return {
        ...row, win: !!row.win, white: { accuracy: row.whiteAccuracy }, black: { accuracy: row.blackAccuracy },
        accuracyByPhase: JSON.parse(row.accuracyByPhase || '[]'),
        labelCounts: JSON.parse(row.labelCounts || '{}'), advancedMetrics: JSON.parse(row.advancedMetrics || '{}'),
    };
}

const AnalysisRepo = {
    save(entry) {
        const transaction = db.transaction((entry) => {
            stmts.insertAnalysis.run(
                entry.id, entry.gameId, entry.username ?? null, entry.createdAt, entry.date, entry.opening, entry.eco ?? null,
                entry.moveCount, entry.color, entry.win, entry.timeControl, entry.white?.accuracy ?? null, entry.black?.accuracy ?? null,
                JSON.stringify(entry.accuracyByPhase || []), JSON.stringify(entry.labelCounts || {}), JSON.stringify(entry.advancedMetrics || {})
            );
            stmts.deletePhases.run(entry.id);
            if (Array.isArray(entry.accuracyByPhase)) for (const { phase, accuracy } of entry.accuracyByPhase) stmts.insertPhase.run(entry.id, phase, accuracy);
            stmts.deleteQuality.run(entry.id);
            if (entry.labelCounts && typeof entry.labelCounts === 'object') for (const [label, count] of Object.entries(entry.labelCounts)) stmts.insertQuality.run(entry.id, label, count);
            stmts.deleteMoves.run(entry.id);
            if (Array.isArray(entry.moves)) for (const m of entry.moves) stmts.insertMove.run(entry.id, m.ply, m.san, m.evaluation, m.label, m.moveTime ?? null, m.remaining_time ?? null, m.fen, m.start_fen);
            if (entry.fullData) stmts.insertFullData.run(entry.gameId, JSON.stringify(entry.fullData));
        });
        transaction(entry);
    },

    findByGameId(gameId) { const row = stmts.findByGameId.get(gameId); return row ? mapRow(row) : null; },
    findAll(offset = 0, limit = 50) { return stmts.findAll.all(limit, offset).map(mapRow); },
    findFullData(gameId) {
        const row = stmts.findFullData.get(gameId);
        if (!row?.full_json) return null;
        try { return JSON.parse(row.full_json); } catch (e) { return null; }
    },
    findFullDataRaw(gameId) { const row = stmts.findFullData.get(gameId); return row?.full_json || null; },

    delete(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        const transaction = db.transaction((ids) => {
            for (const id of ids) {
                stmts.deleteFullData.run(id); // Siempre primero
                stmts.deletePhases.run(id);
                stmts.deleteQuality.run(id);
                stmts.deleteMoves.run(id);
                stmts.deleteAnalysis.run(id);
            }
        });
        transaction(ids);
    },

    clear() {
        stmts.clearAnalyses.run(); stmts.clearPhases.run(); stmts.clearQuality.run(); stmts.clearFullData.run();
    },
    count() { return stmts.count.get().total; },
};

module.exports = AnalysisRepo;