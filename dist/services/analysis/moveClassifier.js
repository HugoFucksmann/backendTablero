import { EvaluationEngine } from './evaluationRules.js';
import { MAX_BOOK_PLY } from '../openings/openingService.js';
export class MoveClassifier {
    static classify({ ply, history, positions, evalResults, bookStatus, openingDone, moveTime, remainingTime }) {
        if (ply < 0 || ply >= history.length)
            return null;
        const before = evalResults[ply];
        const after = evalResults[ply + 1];
        if (!before || !after)
            return null;
        const openingResolved = bookStatus[ply] !== null || openingDone || ply >= MAX_BOOK_PLY;
        if (!openingResolved)
            return null;
        const isWhiteMove = !positions[ply].includes(' b ');
        const movePlayed = history[ply];
        const lan = typeof movePlayed === 'string' ? movePlayed : (movePlayed.lan ?? movePlayed.san);
        const isEngineBest = before.bestMove === lan;
        const isBook = bookStatus[ply] === true;
        let label = isBook
            ? 'Libro'
            : EvaluationEngine.classifyMove(before.wp, after.wp, isWhiteMove, isEngineBest);
        // Lógica de clasificación extendida por tiempo
        let errorTimeClass = null;
        const isBlunder = label === 'Error' || label === 'Error grave' || label === 'Imprecisión';
        if (isBlunder) {
            if (remainingTime !== undefined && remainingTime !== null && remainingTime < 40) {
                errorTimeClass = 'time_pressure';
            }
            else if (moveTime !== undefined && moveTime !== null && moveTime < 3) {
                errorTimeClass = 'precipitation';
            }
            else if (moveTime !== undefined && moveTime !== null && moveTime > 30) {
                errorTimeClass = 'overthinking';
            }
        }
        if (isBlunder) {
            if (remainingTime !== undefined && remainingTime !== null && remainingTime < 10) {
                label = 'Time Pressure Error';
            }
            else if (moveTime !== undefined && moveTime !== null) {
                if (moveTime < 3) {
                    label = 'Insta-move Blunder';
                }
                else if (moveTime > 30) {
                    label = 'Deep-think Blunder';
                }
            }
        }
        let wpLoss = isWhiteMove ? (before.wp - after.wp) : (after.wp - before.wp);
        if (isEngineBest || wpLoss < 0)
            wpLoss = 0;
        return {
            index: ply,
            label,
            isBook,
            wpLoss,
            isWhiteMove,
            moveTime,
            remainingTime,
            errorTimeClass
        };
    }
}
