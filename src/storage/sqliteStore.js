'use strict';

const AnalysisRepo = require('./repositories/analysisRepo');
const StatsRepo = require('./repositories/statsRepo');
const PuzzleRepo = require('./repositories/puzzleRepo');

const SqliteStore = {
    save: (entry) => AnalysisRepo.save(entry),
    getByGameId: (gameId) => AnalysisRepo.findByGameId(gameId),
    getAll: (offset, limit) => AnalysisRepo.findAll(offset, limit),
    getFull: (gameId) => AnalysisRepo.findFullData(gameId),
    getFullRaw: (gameId) => AnalysisRepo.findFullDataRaw(gameId), // [FIX] Zero-copy endpoint
    delete: (ids) => AnalysisRepo.delete(ids),
    clear: () => AnalysisRepo.clear(),
    count: () => AnalysisRepo.count(),

    getStats: (filters) => StatsRepo.getAggregatedStats(filters),
    getAggregatedStats: (filters) => StatsRepo.getAggregatedStats(filters),
    getStatDetails: (category, filters) => StatsRepo.getStatDetails(category, filters),
    getMoveExplorer: (fen) => StatsRepo.getMoveExplorer(fen),

    getPuzzles: () => PuzzleRepo.findAll(),
    savePuzzle: (p) => PuzzleRepo.save(p),
    deletePuzzle: (id) => PuzzleRepo.delete(id),
    incrementPuzzleSolved: (id) => PuzzleRepo.incrementSolved(id),
};

module.exports = { SqliteStore };