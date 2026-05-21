import { Chess } from 'chess.js';
export const MIN_SOLUTION_GAP_CP = 80;
export const MIN_WP_BALANCED = 0.30;
export const MAX_WP_BALANCED = 0.75;
export const MAX_SEQUENCE_DEPTH = 7;
export const MIN_SEQUENCE_MOVES = 3;
export function isTacticalMove(fen, uciMove) {
    if (!fen || !uciMove)
        return false;
    try {
        const chess = new Chess(fen);
        const moveObj = chess.move(uciMove);
        if (!moveObj)
            return false;
        const isCapture = moveObj.flags.includes('c') || moveObj.flags.includes('e');
        const givesCheck = chess.inCheck();
        return isCapture || givesCheck;
    }
    catch {
        return false;
    }
}
export function allowsMate(afterMate) {
    return afterMate !== null && afterMate > 0;
}
export function hasClearSolution(afterEval) {
    const { line1Score, line2Score } = afterEval;
    if (line2Score === null || line2Score === undefined)
        return true; // only one line available
    return Math.abs(line1Score - line2Score) >= MIN_SOLUTION_GAP_CP;
}
export function isBalancedPosition(wp, isWhiteMove) {
    // Normalize to "probability for the side that just blundered"
    const blundererWp = isWhiteMove ? wp : 1 - wp;
    return blundererWp >= MIN_WP_BALANCED && blundererWp <= MAX_WP_BALANCED;
}
export function extractForcedSequence(pvString, startFen, maxMoves = MAX_SEQUENCE_DEPTH, isMatePuzzle = false) {
    if (!pvString || !startFen)
        return [];
    const candidates = pvString.trim().split(' ').filter(Boolean).slice(0, maxMoves);
    if (candidates.length === 0)
        return [];
    try {
        const chess = new Chess(startFen);
        const sequence = [];
        for (const uciMove of candidates) {
            const moveObj = chess.move(uciMove);
            if (!moveObj)
                break;
            const isCapture = moveObj.flags.includes('c') || moveObj.flags.includes('e');
            const givesCheck = chess.inCheck();
            const isMate = chess.isCheckmate();
            sequence.push(uciMove);
            if (isMate)
                break; // puzzle ends at checkmate regardless of length
            if (!isMatePuzzle) {
                if (sequence.length >= MIN_SEQUENCE_MOVES && sequence.length % 2 !== 0 && !isCapture && !givesCheck) {
                    break;
                }
            }
        }
        if (sequence.length > 0 && sequence.length % 2 === 0) {
            sequence.pop();
        }
        return sequence;
    }
    catch (e) {
        console.error('[PuzzleFilter] Error building forced sequence:', e.message);
        return [];
    }
}
export function evaluatePuzzleCandidate(ctx) {
    const { beforeEval, afterEval, isWhiteMove, wpLoss, puzzleFen } = ctx;
    if (wpLoss < 0.15) {
        return { accept: false, reason: 'wpLoss too small' };
    }
    if (allowsMate(afterEval.mate)) {
        if (afterEval.mate === 1) {
            return { accept: false, reason: 'trivial mate in 1' };
        }
        const pv = afterEval.pv || '';
        const seq = extractForcedSequence(pv, puzzleFen, MAX_SEQUENCE_DEPTH, true);
        if (seq.length === 0)
            return { accept: false, reason: 'allows_mate but no valid sequence' };
        return {
            accept: true,
            puzzleType: 'mate',
            mateIn: afterEval.mate,
            solutionSequence: seq,
        };
    }
    const pv = afterEval.pv || '';
    const seq = extractForcedSequence(pv, puzzleFen, MAX_SEQUENCE_DEPTH, false);
    if (seq.length === 0) {
        return { accept: false, reason: 'could not build a valid forced sequence' };
    }
    if (!isTacticalMove(puzzleFen, seq[0])) {
        return { accept: false, reason: 'punishment move is not tactical (positional error)' };
    }
    if (!hasClearSolution(afterEval)) {
        return { accept: false, reason: 'ambiguous solution (multiPV gap too small)' };
    }
    if (!isBalancedPosition(beforeEval.wp, isWhiteMove)) {
        return { accept: false, reason: 'position already decided before blunder' };
    }
    return {
        accept: true,
        puzzleType: 'tactical_blunder',
        mateIn: null,
        solutionSequence: seq,
    };
}
