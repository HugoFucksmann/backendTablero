import { randomUUID } from 'crypto';
import { SqliteStore } from './sqliteStore.js';

export const PuzzleStore = {
    /**
     * Returns all stored puzzles, ordered by creation date descending.
     */
    getAll(): any[] {
        return SqliteStore.getPuzzles();
    },

    /**
     * Persists a new puzzle after checking for duplicates.
     * Duplicate detection is delegated to PuzzleRepo (SQL query, not in-memory scan).
     *
     * @param puzzle  Raw puzzle object from PuzzleExtractor._savePuzzle()
     * @returns The saved entry, or null if it was a duplicate.
     */
    save(puzzle: any): any | null {
        if (SqliteStore.isPuzzleDuplicate(puzzle.fen, puzzle.solutionSequence)) {
            return null;
        }

        // Spread puzzle first so that the generated fields (id, createdAt, solvedCount)
        // always win — even if puzzle ever carries those keys in the future.
        const entry = {
            ...puzzle,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            solvedCount: 0,
        };

        SqliteStore.savePuzzle(entry);
        return entry;
    },

    /**
     * Deletes a puzzle by ID.
     */
    delete(id: string): boolean {
        return SqliteStore.deletePuzzle(id);
    },

    /**
     * Deletes all puzzles.
     * @returns Number of puzzles deleted.
     */
    clear(): number {
        return SqliteStore.clearPuzzles();
    },

    /**
     * Increments the solved counter for a puzzle.
     */
    incrementSolved(id: string): void {
        SqliteStore.incrementPuzzleSolved(id);
    },
};
