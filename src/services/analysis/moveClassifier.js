'use strict';

const { EvaluationEngine } = require('./evaluationRules');
const { MAX_BOOK_PLY } = require('../openings/openingService');

class MoveClassifier {
    static classify({ ply, history, positions, evalResults, bookStatus, openingDone, moveTime, remainingTime }) {
        if (ply < 0 || ply >= history.length) return null;

        const before = evalResults[ply];
        const after = evalResults[ply + 1];
        if (!before || !after) return null;

        const openingResolved = bookStatus[ply] !== null || openingDone || ply >= MAX_BOOK_PLY;
        if (!openingResolved) return null;

        const isWhiteMove = !positions[ply].includes(' b ');
        const movePlayed = history[ply];
        const lan = typeof movePlayed === 'string' ? movePlayed : (movePlayed.lan ?? movePlayed.san);
        
        const isEngineBest = before.bestMove === lan;
        const isBook = bookStatus[ply] === true;

        let label = isBook
            ? 'Libro'
            : EvaluationEngine.classifyMove(before.wp, after.wp, isWhiteMove, isEngineBest);

        // Lógica de clasificación extendida por tiempo
        const isBlunder = label === 'Error' || label === 'Error grave';
        if (isBlunder && moveTime !== undefined) {
            if (moveTime < 3) label = 'Insta-move Blunder';
            else if (moveTime > 30) label = 'Deep-think Blunder';
            
            if (remainingTime !== undefined && remainingTime < 10) {
                label = 'Time Pressure Error';
            }
        }

        let wpLoss = isWhiteMove ? (before.wp - after.wp) : (after.wp - before.wp);
        if (isEngineBest || wpLoss < 0) wpLoss = 0;

        return { index: ply, label, isBook, wpLoss, isWhiteMove, moveTime, remainingTime };
    }


}

module.exports = { MoveClassifier };
