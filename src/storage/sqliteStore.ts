import { AnalysisRepo } from './repositories/analysisRepo.js';
import { StatsRepo } from './repositories/statsRepo.js';
import { PuzzleRepo } from './repositories/puzzleRepo.js';

export const SqliteStore = {
    // ── Analysis ──────────────────────────────────────────────────────────────
    save: (entry: any) => AnalysisRepo.save(entry),
    getByGameId: (gameId: string) => AnalysisRepo.findByGameId(gameId),
    getAll: (offset?: number, limit?: number) => AnalysisRepo.findAll(offset, limit),
    getAllGameIds: () => AnalysisRepo.findAllGameIds(),
    getFull: (gameId: string) => AnalysisRepo.findFullData(gameId),
    delete: (ids: string | string[]) => AnalysisRepo.delete(ids),
    clear: () => AnalysisRepo.clear(),
    count: () => AnalysisRepo.count(),

    // ── Stats ─────────────────────────────────────────────────────────────────
    getStats: (filters?: any) => StatsRepo.getAggregatedStats(filters),
    getAggregatedStats: (filters?: any) => StatsRepo.getAggregatedStats(filters),
    getStatDetails: (category: string, filters?: any) => StatsRepo.getStatDetails(category, filters),
    getMoveExplorer: (fen: string) => StatsRepo.getMoveExplorer(fen),

    // ── Puzzles ───────────────────────────────────────────────────────────────
    getPuzzles: () => PuzzleRepo.findAll(),
    savePuzzle: (p: any) => PuzzleRepo.save(p),
    deletePuzzle: (id: string) => PuzzleRepo.delete(id),
    clearPuzzles: () => PuzzleRepo.clear(),
    incrementPuzzleSolved: (id: string) => PuzzleRepo.incrementSolved(id),
    isPuzzleDuplicate: (fen: string, seq: string[]) => PuzzleRepo.isDuplicate(fen, seq),
};
