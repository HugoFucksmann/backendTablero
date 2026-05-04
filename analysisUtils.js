'use strict';

const { Chess } = require('chess.js');
const { ChessMath } = require('./chessMath');

function buildPositions(history, startFen = null) {
    const positions = [];
    const game = startFen ? new Chess(startFen) : new Chess();
    positions.push(game.fen());
    for (const m of history) {
        game.move(typeof m === 'string' ? m : (m.san ?? m.lan ?? m));
        positions.push(game.fen());
    }
    return positions;
}

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

function mapLines(lines, isBlackTurn) {
    if (!Array.isArray(lines)) return [];
    return lines.map(l => ({
        ...l,
        score: ChessMath.cpToVisualScore(l.score, l.mate ?? null, isBlackTurn),
    }));
}

module.exports = { buildPositions, buildAnalysisOrder, mapLines };
