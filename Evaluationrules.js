'use strict';

/**
 * EvaluationEngine — mirror of evaluationRules.js
 * Classifies individual moves and computes per-colour accuracy.
 */
const EvaluationEngine = {
    /**
     * @param {number}  wpBefore        - White win probability before the move
     * @param {number}  wpAfter         - White win probability after the move
     * @param {boolean} isWhiteMove
     * @param {boolean} isEngineBestMove
     * @returns {string} Spanish label: 'Brillante' | 'Mejor' | 'Excelente' | 'Bueno' | 'Imprecisión' | 'Error' | 'Error grave'
     */
    classifyMove(wpBefore, wpAfter, isWhiteMove, isEngineBestMove) {
        const rawWpLoss = isWhiteMove ? (wpBefore - wpAfter) : (wpAfter - wpBefore);

        if (isEngineBestMove && rawWpLoss <= -0.05) return 'Brillante';
        if (isEngineBestMove) return 'Mejor';

        const wpLoss = Math.max(0, rawWpLoss);

        if (wpLoss <= 0.02) return 'Excelente';
        if (wpLoss <= 0.05) return 'Bueno';
        if (wpLoss <= 0.10) return 'Imprecisión';
        if (wpLoss <= 0.20) return 'Error';

        return 'Error grave';
    },

    /**
     * Computes accuracy [0–100] for white and black separately.
     * Uses the same blended arithmetic/harmonic mean formula as the frontend.
     *
     * @param {Array<{isWhiteMove, wpLoss, isBook}>} moveData
     * @returns {{ white: number, black: number }}
     */
    calculateAccuracy(moveData) {
        const calc = (moves) => {
            const valid = moves.filter(Boolean);
            if (valid.length === 0) return 100;

            let sumAcc = 0;
            let harmSum = 0;

            for (const move of valid) {
                const lossPct = move.wpLoss * 100;
                let acc = lossPct <= 0
                    ? 100
                    : Math.max(0, 103.1668 * Math.exp(-0.07354 * lossPct) - 3.1669);
                acc = Math.max(0, Math.min(100, acc));
                sumAcc += acc;
                harmSum += 1 / Math.max(1, acc);
            }

            const arithmetic = sumAcc / valid.length;
            const harmonic = valid.length / harmSum;

            return Math.max(0, Math.min(100, Math.round((arithmetic + harmonic) / 2)));
        };

        return {
            white: calc(moveData.filter(d => d && d.isWhiteMove && !d.isBook)),
            black: calc(moveData.filter(d => d && !d.isWhiteMove && !d.isBook)),
        };
    },
};

module.exports = { EvaluationEngine };