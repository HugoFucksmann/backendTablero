export const ChessMath = {
    cpToWhiteWinProb(cp, mate, isBlackTurn) {
        if (mate !== null && mate !== undefined) {
            return (mate > 0) === !isBlackTurn ? 1.0 : 0.0;
        }
        const prob = 1 / (1 + Math.exp(-0.00368208 * cp));
        return isBlackTurn ? 1 - prob : prob;
    },
    cpToVisualScore(cp, mate, isBlackTurn) {
        if (mate !== null && mate !== undefined) {
            const sign = mate > 0 ? 1 : -1;
            return isBlackTurn ? -sign * 10 : sign * 10;
        }
        let normalized = Math.max(-10, Math.min(10, cp / 100));
        normalized = Math.round(normalized * 100) / 100;
        return isBlackTurn ? -normalized : normalized;
    },
};
