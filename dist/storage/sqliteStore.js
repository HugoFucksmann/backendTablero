import { AnalysisRepo } from './repositories/analysisRepo.js';
import { StatsRepo } from './repositories/statsRepo.js';
import { PuzzleRepo } from './repositories/puzzleRepo.js';
export const SqliteStore = {
    // ── Analysis ──────────────────────────────────────────────────────────────
    save: (entry) => AnalysisRepo.save(entry),
    getByGameId: (gameId) => AnalysisRepo.findByGameId(gameId),
    getAll: (offset, limit) => AnalysisRepo.findAll(offset, limit),
    getAllGameIds: () => AnalysisRepo.findAllGameIds(),
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
    clearPuzzles: () => PuzzleRepo.clear(),
    incrementPuzzleSolved: (id) => PuzzleRepo.incrementSolved(id),
    isPuzzleDuplicate: (fen, seq) => PuzzleRepo.isDuplicate(fen, seq),
};
