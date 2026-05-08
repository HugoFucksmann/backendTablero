'use strict';

const { Chess } = require('chess.js');
const { ChessMath } = require('./chessMath');

/**
 * AnalysisUtils
 * ─────────────
 * Responsibility: Manipulation of PGN/FEN and preparation of engine data.
 */

/**
 * Extracts clock times from PGN comments like { [%clk 0:03:00] }
 */
function extractTimes(pgn) {
    if (!pgn) return [];
    const times = [];
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

/**
 * Parses PGN string to a verbose history array and extracts start FEN and clock times.
 */
function parsePgn(pgn) {
    if (!pgn) return { history: [], startFen: null, times: [] };
    try {
        const chess = new Chess();
        chess.loadPgn(pgn);
        const history = chess.history({ verbose: true });
        const times = extractTimes(pgn);

        return {
            history: history,
            startFen: chess.header().FEN || null,
            times: times
        };
    } catch (e) {
        console.error('[Utils] PGN Parse Error:', e.message);
        return { history: [], startFen: null, times: [] };
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
