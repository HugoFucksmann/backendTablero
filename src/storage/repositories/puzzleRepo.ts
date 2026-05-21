import db from '../db.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface Puzzle {
    id: string;
    createdAt: string;
    solvedCount: number;
    fen: string;
    solutionSequence: string[];
    baseFen?: string | null;
    contextMoves?: any[] | null;
    originalContinuation?: any[] | null;
    preBlunderFen?: string | null;
    playedMove?: string | null;
    label?: string | null;
    puzzleType?: string | null;
    mateIn?: number | null;
    wpLoss?: number | null;
    preBlunderWp?: number | null;
    playerColor?: string | null;
    gameId?: string | null;
    ply?: number | null;
    blunderSeverity?: number | null;
    tensionIndex?: number | null;
    attackedSquares?: number | null;
    isOnlyMove?: boolean;
    criticalityGap?: number | null;
    tacticalMotifs?: string[] | null;
    initialMove?: string | null;
    theme?: string | null;
    difficulty?: string | null;
    
    // Joined fields from analyses
    opponent?: string | null;
    win?: number | null;
    gameDate?: string | null;
}

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmts = {
    findAll: db.prepare(`
        SELECT p.*, a.opponent, a.win, COALESCE(a.gameDate, a.date) as gameDate
        FROM puzzles p
        LEFT JOIN analyses a ON p.gameId = a.gameId
        ORDER BY p.createdAt DESC
    `),

    // Duplicate check by fen + solutionSequence
    findDuplicate: db.prepare(`
        SELECT id FROM puzzles
        WHERE fen = ? AND solutionSequence = ?
        LIMIT 1
    `),

    insert: db.prepare(`
        INSERT INTO puzzles (
            id, createdAt, solvedCount,
            fen, solutionSequence, baseFen, contextMoves, originalContinuation,
            preBlunderFen, playedMove,
            label, puzzleType, mateIn,
            wpLoss, preBlunderWp, playerColor, gameId, ply,
            blunderSeverity, tensionIndex, attackedSquares,
            isOnlyMove, criticalityGap, tacticalMotifs,
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

function mapRow(row: any): Puzzle {
    return {
        ...row,
        solutionSequence: safeJsonParse(row.solutionSequence, []),
        contextMoves: safeJsonParse(row.contextMoves, []),
        originalContinuation: safeJsonParse(row.originalContinuation, []),
        tacticalMotifs: safeJsonParse(row.tacticalMotifs, []),
        isOnlyMove: row.isOnlyMove === 1,
    };
}

function safeJsonParse(value: any, fallback: any): any {
    if (value === null || value === undefined) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const PuzzleRepo = {
    /**
     * Returns all puzzles ordered by creation date descending.
     */
    findAll(): Puzzle[] {
        return stmts.findAll.all().map(mapRow);
    },

    /**
     * Returns true if a puzzle with the same fen + solutionSequence already exists.
     * Uses a single indexed SQL query.
     */
    isDuplicate(fen: string, solutionSequence: string[]): boolean {
        const row = stmts.findDuplicate.get(fen, JSON.stringify(solutionSequence));
        return row !== undefined;
    },

    /**
     * Persists a new puzzle. Expects the full enriched object produced by
     * PuzzleExtractor._savePuzzle() (after PuzzleStore has attached id/createdAt).
     */
    save(puzzle: Puzzle): Puzzle {
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
     */
    delete(id: string): boolean {
        const result = stmts.delete.run(id);
        return (result.changes ?? 0) > 0;
    },

    /**
     * Deletes all puzzles.
     */
    clear(): number {
        const result = stmts.clear.run();
        return result.changes ?? 0;
    },

    /**
     * Increments the solved counter for a puzzle.
     */
    incrementSolved(id: string): boolean {
        const result = stmts.incrementSolved.run(id);
        return (result.changes ?? 0) > 0;
    },
};
