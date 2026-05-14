'use strict';

const db = require('../db');

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
    findAll: db.prepare(`SELECT * FROM puzzles ORDER BY createdAt DESC`),

    insert: db.prepare(`
        INSERT INTO puzzles (id, createdAt, fen, solutionSequence, initialMove, theme, difficulty, solvedCount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    delete: db.prepare(`DELETE FROM puzzles WHERE id = ?`),
    incrementSolved: db.prepare(`UPDATE puzzles SET solvedCount = solvedCount + 1 WHERE id = ?`),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deserializes a raw SQLite puzzle row.
 * @param {object} row
 * @returns {object}
 */
function mapRow(row) {
    return {
        ...row,
        solutionSequence: JSON.parse(row.solutionSequence),
    };
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
     * Persists a new puzzle.
     * @param {object} puzzle  - Must include all required fields plus a pre-generated `id`.
     * @returns {object}       - The saved puzzle object.
     */
    save(puzzle) {
        stmts.insert.run(
            puzzle.id,
            puzzle.createdAt,
            puzzle.fen,
            JSON.stringify(puzzle.solutionSequence),
            puzzle.initialMove,
            puzzle.theme,
            puzzle.difficulty,
            puzzle.solvedCount ?? 0,
        );
        return puzzle;
    },

    /**
     * Deletes a puzzle by its ID.
     * @param {string} id
     * @returns {boolean}  - `true` if a row was deleted.
     */
    delete(id) {
        return stmts.delete.run(id).changes > 0;
    },

    /**
     * Increments the solved counter for a puzzle.
     * @param {string} id
     * @returns {boolean}  - `true` if the row was updated.
     */
    incrementSolved(id) {
        return stmts.incrementSolved.run(id).changes > 0;
    },
};

module.exports = PuzzleRepo;