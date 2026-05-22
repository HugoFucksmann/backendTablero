import { Chess, Move } from 'chess.js';
import { ChessMath } from './chessMath.js';

/**
 * Extracts clock times from PGN comments like { [%clk 0:03:00] }
 */
export function extractTimes(pgn: string): number[] {
    if (!pgn) return [];
    const times: number[] = [];
    const clkRegex = /\{ \[%clk (\d+):(\d+):(\d+)\] \}/g;
    let match;
    while ((match = clkRegex.exec(pgn)) !== null) {
        const h = parseInt(match[1]);
        const m = parseInt(match[2]);
        const s = parseInt(match[3]);
        times.push(h * 3600 + m * 60 + s);
    }
    return times;
}

export interface ParsedPgn {
    history: Move[];
    startFen: string | null;
    times: number[];
    headers: Record<string, string | null>;
}

/**
 * Parses PGN string to a verbose history array and extracts start FEN and clock times.
 */
export function parsePgn(pgn: string): ParsedPgn {
    if (!pgn) return { history: [], startFen: null, times: [], headers: {} };
    try {
        const chess = new Chess();
        chess.loadPgn(pgn);
        const history = chess.history({ verbose: true });
        const times = extractTimes(pgn);
        const headers = chess.header();

        return {
            history,
            startFen: headers.FEN || null,
            times,
            headers,
        };
    } catch (e: any) {
        console.error('[Utils] PGN Parse Error:', e.message);
        return { history: [], startFen: null, times: [], headers: {} };
    }
}

/**
 * Generates an array of FENs for each position in the game.
 * positions[0] is the starting FEN, positions[n] is after move n.
 */
export function buildPositions(history: (string | Move | any)[], startFen: string | null = null): string[] {
    const positions: string[] = [];
    const game = startFen ? new Chess(startFen) : new Chess();
    positions.push(game.fen());
    for (const m of history) {
        // Robust move handling: try lan, then san, then the object itself
        const moveStr = typeof m === 'string' ? m : (m.lan ?? m.san ?? m);
        try {
            game.move(moveStr);
            positions.push(game.fen());
        } catch (e) {
            console.warn(`[Utils] Skipping invalid move: ${JSON.stringify(m)}`);
            // Mantenemos el array alineado duplicando la posición anterior
            positions.push(positions[positions.length - 1]);
        }
    }
    return positions;
}

/**
 * Creates an evaluation order that prioritizes the current move and its neighbors.
 */
export function buildAnalysisOrder(total: number, currentIndex: number): number[] {
    const order: number[] = [];
    const seen = new Set<number>();
    const add = (i: number) => { 
        if (i >= 0 && i < total && !seen.has(i)) { 
            order.push(i); 
            seen.add(i); 
        } 
    };

    if (currentIndex >= 0 && currentIndex < total - 1) { 
        add(currentIndex); 
        add(currentIndex + 1); 
    }
    if (currentIndex > 0) add(currentIndex - 1);
    
    for (let i = 0; i < total; i++) add(i);
    return order;
}

export interface EngineLine {
    pv: string;
    score: number;
    depth: number;
    mate?: number | null;
    [key: string]: any;
}

export interface EvaluationResult {
    wp: number;
    score: number | string;
    mate: number | null;
    bestMove: string;
    lines: EngineLine[];
}

export interface ClassifiedMoveData {
    label: string;
    isWhiteMove: boolean;
    wpLoss: number;
    isBook: boolean;
    phase: string;
    moveTime?: number;
    remainingTime?: number;
    errorTimeClass: 'time_pressure' | 'precipitation' | 'overthinking' | null;
    fen: string;
}

/**
 * Maps engine PV lines to a format the UI expects.
 */
export function mapLines(lines: EngineLine[], isBlackTurn: boolean): EngineLine[] {
    if (!Array.isArray(lines)) return [];
    return lines.map(l => ({
        ...l,
        score: ChessMath.cpToVisualScore(l.score, l.mate ?? null, isBlackTurn),
    }));
}
