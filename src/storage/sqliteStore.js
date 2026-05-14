'use strict';

/**
 * SqliteStore — Compatibility facade
 *
 * Re-exports the full original API by delegating to the three focused repositories.
 * gameStore.js and puzzleStore.js continue to import from this file without any changes.
 *
 * Internal consumers should prefer importing repositories directly:
 *   const AnalysisRepo = require('./repositories/analysisRepo');
 *   const StatsRepo    = require('./repositories/statsRepo');
 *   const PuzzleRepo   = require('./repositories/puzzleRepo');
 */

const AnalysisRepo = require('./repositories/analysisRepo');
const StatsRepo = require('./repositories/statsRepo');
const PuzzleRepo = require('./repositories/puzzleRepo');

const SqliteStore = {
    // ── Analysis ──────────────────────────────────────────────────────────────
    save: (entry) => AnalysisRepo.save(entry),
    getByGameId: (gameId) => AnalysisRepo.findByGameId(gameId),
    getAll: (offset, limit) => AnalysisRepo.findAll(offset, limit),
    getFull: (gameId) => AnalysisRepo.findFullData(gameId),
    delete: (ids) => AnalysisRepo.delete(ids),
    clear: () => AnalysisRepo.clear(),
    count: () => AnalysisRepo.count(),

    // ── Stats ─────────────────────────────────────────────────────────────────
    getStats: (filters) => StatsRepo.getAggregatedStats(filters),
    getAggregatedStats: (filters) => StatsRepo.getAggregatedStats(filters),
    getStatDetails: (category, filters) => StatsRepo.getStatDetails(category, filters),
    getMoveExplorer: (fen) => StatsRepo.getMoveExplorer(fen),

    // ── Puzzles ───────────────────────────────────────────────────────────────
    getPuzzles: () => PuzzleRepo.findAll(),
    savePuzzle: (p) => PuzzleRepo.save(p),
    deletePuzzle: (id) => PuzzleRepo.delete(id),
    incrementPuzzleSolved: (id) => PuzzleRepo.incrementSolved(id),
};

module.exports = { SqliteStore };