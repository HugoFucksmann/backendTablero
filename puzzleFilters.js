'use strict';

const { Chess } = require('chess.js');

// ─── Thresholds (single source of truth) ─────────────────────────────────────

/**
 * Minimum centipawn gap between line 1 and line 2 in the post-blunder position.
 * Below this the puzzle has more than one "correct" answer and is ambiguous.
 */
const MIN_SOLUTION_GAP_CP = 80;

/**
 * Pre-blunder win-probability window (White's perspective, 0..1).
 * Outside this range the game was already decided — no pedagogical value.
 */
const MIN_WP_BALANCED = 0.30;
const MAX_WP_BALANCED = 0.75;

/**
 * Maximum moves to consider when building the forced solution sequence.
 */
const MAX_SEQUENCE_DEPTH = 7;

// ─── Individual filter functions ──────────────────────────────────────────────

/**
 * Returns true if playing `uciMove` from `fen` is a capture OR gives check.
 * These are the two hallmarks of a tactical move worth turning into a puzzle.
 *
 * @param {string} fen
 * @param {string} uciMove  UCI notation, e.g. "e2e4" or "g1f3"
 * @returns {boolean}
 */
function isTacticalMove(fen, uciMove) {
    if (!fen || !uciMove) return false;
    try {
        const chess = new Chess(fen);
        const moveObj = chess.move(uciMove, { sloppy: true });
        if (!moveObj) return false;

        const isCapture = moveObj.flags.includes('c') || moveObj.flags.includes('e');
        const givesCheck = chess.inCheck();
        return isCapture || givesCheck;
    } catch {
        return false;
    }
}

/**
 * Returns true if the engine had a forced mate available at this position
 * but the player didn't play the best move.
 *
 * `beforeMate` — the `mate` field from the pre-blunder eval (null = no mate).
 * Positive value means the side-to-move has the forced mate.
 *
 * @param {number|null} beforeMate
 * @param {boolean}     isEngineBest
 * @returns {boolean}
 */
function isMissedMate(beforeMate, isEngineBest) {
    return !isEngineBest && beforeMate !== null && beforeMate > 0;
}

/**
 * Returns true when the post-blunder position has one clearly superior response.
 * Requires `afterEval` to carry `line1Score` and `line2Score` (populated when
 * analyzePosition is called with multiPv=2).
 *
 * @param {{ line1Score: number, line2Score: number|null }} afterEval
 * @returns {boolean}
 */
function hasClearSolution(afterEval) {
    const { line1Score, line2Score } = afterEval;
    if (line2Score === null || line2Score === undefined) return true; // only one line available
    return Math.abs(line1Score - line2Score) >= MIN_SOLUTION_GAP_CP;
}

/**
 * Returns true when the position before the blunder was genuinely contested
 * (neither side was already lost or crushing). A missed tactic in a dead-lost
 * position teaches nothing.
 *
 * @param {number}  wp           Win probability, always from White's perspective [0..1].
 * @param {boolean} isWhiteMove  Whose turn it was when the blunder happened.
 * @returns {boolean}
 */
function isBalancedPosition(wp, isWhiteMove) {
    // Normalize to "probability for the side that just blundered"
    const blundererWp = isWhiteMove ? wp : 1 - wp;
    return blundererWp >= MIN_WP_BALANCED && blundererWp <= MAX_WP_BALANCED;
}

/**
 * Walks the principal variation from `startFen` and builds the solution sequence.
 *
 * Structure of the variation from the puzzle position (after the blunder):
 *   move 1 (odd):  best response by the side that didn't blunder  ← the punishing move
 *   move 2 (even): forced reply by the side that blundered        ← the bad position
 *   move 3 (odd):  the follow-up that demonstrates why it's lost  ← "the lost move"
 *
 * Rules:
 *  - Always include at least MIN_SEQUENCE_MOVES moves (or until mate/end of PV),
 *    so the player always sees the full punishing idea, not just the first capture.
 *  - After MIN_SEQUENCE_MOVES, stop at the first quiet move (non-capture, non-check)
 *    to avoid trailing off into long positional play the solver can't follow.
 *  - Always stop at checkmate.
 *
 * @param {string} pvString   Space-separated UCI moves, e.g. "d1h5 e8d8 h5f7"
 * @param {string} startFen   FEN of the position AFTER the blunder (puzzle start).
 * @param {number} [maxMoves]
 * @returns {string[]}        Array of UCI moves forming the forced sequence.
 */
const MIN_SEQUENCE_MOVES = 3; // must show: punish → defense → consequence

function extractForcedSequence(pvString, startFen, maxMoves = MAX_SEQUENCE_DEPTH) {
    if (!pvString || !startFen) return [];

    const candidates = pvString.trim().split(' ').filter(Boolean).slice(0, maxMoves);
    if (candidates.length === 0) return [];

    try {
        const chess = new Chess(startFen);
        const sequence = [];

        for (const uciMove of candidates) {
            const moveObj = chess.move(uciMove, { sloppy: true });
            if (!moveObj) break;

            const isCapture = moveObj.flags.includes('c') || moveObj.flags.includes('e');
            const givesCheck = chess.inCheck();
            const isMate = chess.isCheckmate();

            sequence.push(uciMove);

            if (isMate) break; // puzzle ends at checkmate regardless of length

            // Only cut on quiet moves once we've shown the minimum required context.
            // Before MIN_SEQUENCE_MOVES, always continue so the "lost move" is visible.
            if (sequence.length >= MIN_SEQUENCE_MOVES && !isCapture && !givesCheck) break;
        }

        return sequence;
    } catch {
        // Safety fallback: at least give back the first move
        return candidates.slice(0, 1);
    }
}

/**
 * High-level entry point that runs all filters in the recommended order and
 * returns a result object. Keeping the decision logic here (not scattered in
 * _processGame) makes it easy to unit-test each filter independently.
 *
 * @param {{
 *   beforeEval:   { wp: number, bestMove: string|null, mate: number|null },
 *   afterEval:    { wp: number, pv: string, line1Score: number, line2Score: number|null },
 *   isWhiteMove:  boolean,
 *   isEngineBest: boolean,
 *   wpLoss:       number,
 *   puzzleFen:    string,   // FEN AFTER the blunder
 *   preBlunderFen: string,   // FEN BEFORE the blunder
 * }} ctx
 * @returns {{ accept: boolean, reason?: string, puzzleType?: string,
 *             solutionSequence?: string[], mateIn?: number|null }}
 */
function evaluatePuzzleCandidate(ctx) {
    const { beforeEval, afterEval, isWhiteMove, isEngineBest, wpLoss, puzzleFen, preBlunderFen } = ctx;

    // ── Gate 1: minimum material loss ────────────────────────────────────────
    // (already checked upstream, but defensive re-check here)
    if (wpLoss < 0.15) {
        return { accept: false, reason: 'wpLoss too small' };
    }

    // ── Gate 2: missed forced mate — always a puzzle, skip balance check ─────
    const missedMate = isMissedMate(beforeEval.mate, isEngineBest);
    if (missedMate) {
        const pv = afterEval.pv || '';
        const seq = extractForcedSequence(pv, puzzleFen);
        if (seq.length === 0) return { accept: false, reason: 'missed_mate but no valid sequence' };
        return {
            accept: true,
            puzzleType: 'missed_mate',
            mateIn: beforeEval.mate,
            solutionSequence: seq,
        };
    }

    // ── Gate 3: the move the player *should* have played must be tactical ─────
    if (!isTacticalMove(preBlunderFen, beforeEval.bestMove)) {
        return { accept: false, reason: 'best move was not tactical (positional error)' };
    }

    // ── Gate 4: solution must be unambiguous (clear winner in post-blunder pos) ─
    if (!hasClearSolution(afterEval)) {
        return { accept: false, reason: 'ambiguous solution (multiPV gap too small)' };
    }

    // ── Gate 5: position must have been balanced before the blunder ───────────
    if (!isBalancedPosition(beforeEval.wp, isWhiteMove)) {
        return { accept: false, reason: 'position already decided before blunder' };
    }

    // ── Gate 6: build and validate forced sequence ────────────────────────────
    const pv = afterEval.pv || '';
    const seq = extractForcedSequence(pv, puzzleFen);
    if (seq.length === 0) {
        return { accept: false, reason: 'could not build a valid forced sequence' };
    }

    return {
        accept: true,
        puzzleType: 'tactical_blunder',
        mateIn: null,
        solutionSequence: seq,
    };
}

module.exports = {
    // Individual filters (useful for unit tests)
    isTacticalMove,
    isMissedMate,
    hasClearSolution,
    isBalancedPosition,
    extractForcedSequence,
    // Orchestrator
    evaluatePuzzleCandidate,
    // Exported constants so callers can reference them without magic numbers
    MIN_SOLUTION_GAP_CP,
    MIN_WP_BALANCED,
    MAX_WP_BALANCED,
    MAX_SEQUENCE_DEPTH,
    MIN_SEQUENCE_MOVES,
};