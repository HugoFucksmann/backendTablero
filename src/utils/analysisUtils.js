'use strict';

const { Chess } = require('chess.js');
const { ChessMath } = require('./chessMath');

/**
 * AnalysisUtils
 * ─────────────
 * Responsibility: Manipulation of PGN/FEN and preparation of engine data.
 */

/**
 * Parses PGN string to a verbose history array and extracts start FEN.
 */
function parsePgn(pgn) {
    if (!pgn) return { history: [], startFen: null };
    try {
        const chess = new Chess();
        // chess.js loadPgn can be strict. We try to load it and if it fails to 
        // produce a history, then we consider it invalid.
        chess.loadPgn(pgn);
        const history = chess.history({ verbose: true });
        
        // If history is empty, maybe it's just a move list? Try loading as moves
        if (history.length === 0 && pgn.trim().length > 0) {
            // Check if it's just a single move or list of moves without headers
            // loadPgn should handle it, but we can try to see if there's any info
        }

        return {
            history: history,
            startFen: chess.header().FEN || null
        };
    } catch (e) {
        console.error('[Utils] PGN Parse Error:', e.message);
        return { history: [], startFen: null };
    }
}

/**
 * Generates an array of FENs for each position in the game.
 * positions[0] is the starting FEN, positions[n] is after move n.
 */
function buildPositions(history, startFen = null) {
    const positions = [];
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
            // Keep the previous FEN to maintain array length consistency if needed, 
            // but usually we want to stop or skip. Here we skip.
        }
    }
    return positions;
}

/**
 * Creates an evaluation order that prioritizes the current move and its neighbors.
 */
function buildAnalysisOrder(total, currentIndex) {
    const order = [];
    const seen = new Set();
    const add = (i) => { 
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

/**
 * Maps engine PV lines to a format the UI expects.
 */
function mapLines(lines, isBlackTurn) {
    if (!Array.isArray(lines)) return [];
    return lines.map(l => ({
        ...l,
        score: ChessMath.cpToVisualScore(l.score, l.mate ?? null, isBlackTurn),
    }));
}

module.exports = { 
    parsePgn,
    buildPositions, 
    buildAnalysisOrder, 
    mapLines 
};
