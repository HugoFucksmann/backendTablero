import { EvaluationEngine } from './evaluationRules.js';
const PHASE_COLORS = {
    'Apertura': '#4caf50',
    'Medio Juego': '#ff9800',
    'Final': '#2196f3',
};
const PHASES = ['Apertura', 'Medio Juego', 'Final'];
export function calculate({ finalMoveData, evalResults, playerColor, winNormalized }) {
    const accuracyByPhase = _calcAccuracyByPhase(finalMoveData, playerColor);
    const advancedMetrics = _calcAdvancedMetrics(finalMoveData, evalResults, playerColor, winNormalized);
    return { accuracyByPhase, advancedMetrics };
}
// ─── Private Helpers ──────────────────────────────────────────────────────────
function _calcAccuracyByPhase(finalMoveData, playerColor) {
    const results = [];
    for (const phase of PHASES) {
        const movesInPhase = finalMoveData.filter(m => m && m.phase === phase);
        if (movesInPhase.length === 0)
            continue;
        const accObj = EvaluationEngine.calculateAccuracy(movesInPhase);
        const playerAcc = accObj[playerColor || 'white'];
        results.push({ phase, accuracy: playerAcc, color: PHASE_COLORS[phase] });
    }
    return results;
}
function _calcAdvancedMetrics(finalMoveData, evalResults, playerColor, winNormalized) {
    const isUserWhite = playerColor === 'white';
    const metrics = {
        advantageStatus: 'none',
        comebackStatus: 'none',
        tiltEvents: 0,
        tiltFens: [],
        comebackFens: [],
        blownAdvantageFens: [],
        timeManagement: {
            avgMidgameTime: 0,
            avgBlunderTime: 0,
            ratio: 1,
        },
        errorTimeStats: {
            timePressureCount: 0,
            precipitationCount: 0,
            overthinkingCount: 0,
            totalErrors: 0,
        },
    };
    let maxUserWp = 0;
    let maxWpFen = null;
    let maxWpFenPly = null;
    let minUserWp = 1;
    let minWpFen = null;
    let minWpFenPly = null;
    let midgameTimeSum = 0;
    let midgameCount = 0;
    let blunderTimeSum = 0;
    let blunderCount = 0;
    let tiltCount = 0;
    const tiltCandidates = [];
    for (let i = 0; i < finalMoveData.length; i++) {
        const m = finalMoveData[i];
        if (!m)
            continue;
        // ── Time error stats tracking ─────────────────────────────────────────
        const isUserError = m.isWhiteMove === isUserWhite &&
            (m.label === 'Error' || m.label === 'Error grave' || m.label === 'Imprecisión' ||
                ['Error', 'Error grave', 'Imprecisión', 'Insta-move Blunder', 'Deep-think Blunder', 'Time Pressure Error'].includes(m.label));
        if (isUserError) {
            metrics.errorTimeStats.totalErrors++;
            if (m.errorTimeClass === 'time_pressure') {
                metrics.errorTimeStats.timePressureCount++;
            }
            else if (m.errorTimeClass === 'precipitation') {
                metrics.errorTimeStats.precipitationCount++;
            }
            else if (m.errorTimeClass === 'overthinking') {
                metrics.errorTimeStats.overthinkingCount++;
            }
        }
        // ── Win probability tracking ──────────────────────────────────────────
        const evalResult = evalResults[i + 1];
        if (evalResult?.wp !== undefined) {
            const userWp = isUserWhite ? evalResult.wp : (1 - evalResult.wp);
            if (userWp > maxUserWp) {
                maxUserWp = userWp;
                maxWpFen = m.fen;
                maxWpFenPly = i;
            }
            if (userWp < minUserWp) {
                minUserWp = userWp;
                minWpFen = m.fen;
                minWpFenPly = i;
            }
        }
        // ── Tilt detection ────────────────────────────────────────────────────
        if (m.isWhiteMove === isUserWhite && (m.label === 'Error' || m.label === 'Error grave')) {
            let lossSum = 0;
            let count = 0;
            for (let j = i + 2; j <= i + 6; j += 2) {
                if (finalMoveData[j]) {
                    lossSum += finalMoveData[j].wpLoss || 0;
                    count++;
                }
            }
            if (count > 0) {
                const avgLoss = lossSum / count;
                if (avgLoss > 0.15) {
                    tiltCount++;
                    tiltCandidates.push({ fen: m.fen, ply: i, avgLoss });
                }
            }
        }
        // ── Time management ───────────────────────────────────────────────────
        if (m.isWhiteMove === isUserWhite && m.moveTime !== undefined && m.moveTime !== null) {
            if (m.phase === 'Medio Juego') {
                midgameTimeSum += m.moveTime;
                midgameCount++;
            }
            const isBlunderLabel = [
                'Error grave', 'Insta-move Blunder',
                'Deep-think Blunder', 'Time Pressure Error',
            ].includes(m.label);
            if (isBlunderLabel) {
                blunderTimeSum += m.moveTime;
                blunderCount++;
            }
        }
    }
    // ── Advantage status ──────────────────────────────────────────────────────
    if (maxUserWp > 0.75) {
        if (winNormalized === 1) {
            metrics.advantageStatus = 'CONVERTED';
        }
        else {
            metrics.advantageStatus = 'BLOWN_ADVANTAGE';
            if (maxWpFen && maxWpFenPly !== null) {
                metrics.blownAdvantageFens.push({ fen: maxWpFen, ply: maxWpFenPly });
            }
        }
    }
    // ── Comeback / Resilience ─────────────────────────────────────────────────
    if (minUserWp < 0.20) {
        if (winNormalized === 1) {
            metrics.comebackStatus = 'COMEBACK_WIN';
            if (minWpFen && minWpFenPly !== null) {
                metrics.comebackFens.push({ fen: minWpFen, ply: minWpFenPly });
            }
        }
        else if (winNormalized === 0) {
            metrics.comebackStatus = 'SAVED_DRAW';
            if (minWpFen && minWpFenPly !== null) {
                metrics.comebackFens.push({ fen: minWpFen, ply: minWpFenPly });
            }
        }
        else {
            metrics.comebackStatus = 'FAILED';
        }
    }
    // ── Tilt summary ──────────────────────────────────────────────────────────
    metrics.tiltEvents = tiltCount;
    metrics.tiltFens = tiltCandidates
        .sort((a, b) => b.avgLoss - a.avgLoss)
        .slice(0, 2)
        .map(({ fen, ply }) => ({ fen, ply }));
    // ── Time management ratios ────────────────────────────────────────────────
    if (midgameCount > 0)
        metrics.timeManagement.avgMidgameTime = midgameTimeSum / midgameCount;
    if (blunderCount > 0)
        metrics.timeManagement.avgBlunderTime = blunderTimeSum / blunderCount;
    if (metrics.timeManagement.avgMidgameTime > 0) {
        metrics.timeManagement.ratio =
            metrics.timeManagement.avgBlunderTime / metrics.timeManagement.avgMidgameTime;
    }
    return metrics;
}
