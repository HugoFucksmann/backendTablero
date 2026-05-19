'use strict';

const db = require('../db');

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
    findAll: db.prepare(`SELECT * FROM puzzles ORDER BY createdAt DESC`),

    // Duplicate check by fen + solutionSequence — done in SQL, not in-memory.
    findDuplicate: db.prepare(`
        SELECT id FROM puzzles
        WHERE fen = ? AND solutionSequence = ?
        LIMIT 1
    `),

    insert: db.prepare(`
        INSERT INTO puzzles (
            id, createdAt, solvedCount,
            -- Puzzle position & solution
            fen, solutionSequence, baseFen, contextMoves, originalContinuation,
            preBlunderFen, playedMove,
            -- Classification
            label, puzzleType, mateIn,
            -- Metrics
            wpLoss, preBlunderWp, playerColor, gameId, ply,
            -- Enriched / mined data
            blunderSeverity, tensionIndex, attackedSquares,
            isOnlyMove, criticalityGap, tacticalMotifs,
            -- Legacy columns (null for new puzzles; kept for schema compatibility)
            initialMove, theme, difficulty
        ) VALUES (
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            NULL, NULL, NULL
        )
    `),

    delete: db.prepare(`DELETE FROM puzzles WHERE id = ?`),

    clear: db.prepare(`DELETE FROM puzzles`),

    incrementSolved: db.prepare(`
        UPDATE puzzles SET solvedCount = solvedCount + 1 WHERE id = ?
    `),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deserializes a raw SQLite puzzle row.
 * - JSON fields: solutionSequence, contextMoves, originalContinuation, tacticalMotifs
 * - Boolean field: isOnlyMove (stored as INTEGER 0/1)
 *
 * @param {object} row
 * @returns {object}
 */
function mapRow(row) {
    return {
        ...row,
        solutionSequence: safeJsonParse(row.solutionSequence, []),
        contextMoves: safeJsonParse(row.contextMoves, []),
        originalContinuation: safeJsonParse(row.originalContinuation, []),
        tacticalMotifs: safeJsonParse(row.tacticalMotifs, []),
        isOnlyMove: row.isOnlyMove === 1,
    };
}

function safeJsonParse(value, fallback) {
    if (value === null || value === undefined) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

// ─── Repository ───────────────────────────────────────────────────────────────

const PuzzleRepo = {

    /**
     * Returns all puzzles ordered by creation date descending.
     * @returns {object[]}
     */
    findAll() {
        return stmts.findAll.all().map(mapRow);
    },

    /**
     * Returns true if a puzzle with the same fen + solutionSequence already exists.
     * Uses a single indexed SQL query — O(log n), not O(n) in-memory scan.
     *
     * @param {string} fen
     * @param {string[]} solutionSequence
     * @returns {boolean}
     */
    isDuplicate(fen, solutionSequence) {
        const row = stmts.findDuplicate.get(fen, JSON.stringify(solutionSequence));
        return row !== undefined;
    },

    /**
     * Persists a new puzzle. Expects the full enriched object produced by
     * PuzzleExtractor._savePuzzle() (after PuzzleStore has attached id/createdAt).
     *
     * @param {object} puzzle
     * @returns {object} The saved puzzle object.
     */
    save(puzzle) {
        stmts.insert.run(
            // Core
            puzzle.id,
            puzzle.createdAt,
            puzzle.solvedCount ?? 0,
            // Position & solution
            puzzle.fen,
            JSON.stringify(puzzle.solutionSequence ?? []),
            puzzle.baseFen ?? null,
            JSON.stringify(puzzle.contextMoves ?? []),
            JSON.stringify(puzzle.originalContinuation ?? []),
            puzzle.preBlunderFen ?? null,
            puzzle.playedMove ?? null,
            // Classification
            puzzle.label ?? null,
            puzzle.puzzleType ?? null,
            puzzle.mateIn ?? null,
            // Metrics
            puzzle.wpLoss ?? null,
            puzzle.preBlunderWp ?? null,
            puzzle.playerColor ?? null,
            puzzle.gameId ?? null,
            puzzle.ply ?? null,
            // Enriched data
            puzzle.blunderSeverity ?? null,
            puzzle.tensionIndex ?? null,
            puzzle.attackedSquares ?? null,
            puzzle.isOnlyMove ? 1 : 0,
            puzzle.criticalityGap ?? null,
            JSON.stringify(puzzle.tacticalMotifs ?? []),
        );
        return puzzle;
    },

    /**
     * Deletes a puzzle by its ID.
     * @param {string} id
     * @returns {boolean} true if a row was deleted.
     */
    delete(id) {
        return stmts.delete.run(id).changes > 0;
    },

    /**
     * Deletes all puzzles.
     * @returns {number} Number of rows deleted.
     */
    clear() {
        return stmts.clear.run().changes;
    },

    /**
     * Increments the solved counter for a puzzle.
     * @param {string} id
     * @returns {boolean} true if the row was updated.
     */
    incrementSolved(id) {
        return stmts.incrementSolved.run(id).changes > 0;
    },
};

module.exports = PuzzleRepo;