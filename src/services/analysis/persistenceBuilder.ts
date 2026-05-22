import { Move } from 'chess.js';
import { EvaluationResult, ClassifiedMoveData } from '../../utils/analysisUtils.js';

export interface BuildParams {
    gameId: string;
    history: (string | Move)[];
    positions: string[];
    evalResults: (EvaluationResult | undefined)[];
    finalMoveData: (ClassifiedMoveData | undefined)[];
    completedSet: Set<number>;
    accuracy: { white: number; black: number };
    accuracyByPhase: { phase: string; accuracy: number }[];
    opening: { name: string; eco: string };
    players: { white: string | null; black: string | null };
    startFen: string | null | undefined;
    win: number | null;
    playerColor: 'white' | 'black';
}

export interface PersistenceResult {
    fullData: any;
    movesToSave: any[];
}

export function build({
    history,
    positions,
    evalResults,
    finalMoveData,
    completedSet,
    accuracy,
    accuracyByPhase,
    opening,
    players,
    startFen,
    win,
    playerColor,
}: BuildParams): PersistenceResult {
    const completedIndexes = Array.from(completedSet);

    const fullData = {
        accuracy,
        accuracyByPhase: accuracyByPhase ?? [],
        win: win ?? null,
        playerColor: playerColor ?? 'white',
        opening: { name: opening.name, eco: opening.eco },
        players: { white: players.white, black: players.black },
        startFen: startFen || null,
        // historySan: SAN strings (e4, Nf3) — required by applyFullAnalysis to replay moves via chess.js
        historySan: history.map(m => (typeof m === 'string' ? m : m.san)),
        // history: LAN strings (e2e4) — kept for backward compat / UCI tooling
        history: history.map(m => (typeof m === 'string' ? m : (m.lan ?? m.san))),
        positions,
        evaluations: evalResults,
        moveEvaluations: Object.fromEntries(
            completedIndexes
                .filter(idx => finalMoveData[idx]?.label)
                .map(idx => [idx, finalMoveData[idx]!.label])
        ),
        errorTimeClasses: Object.fromEntries(
            completedIndexes
                .filter(idx => finalMoveData[idx]?.errorTimeClass)
                .map(idx => [idx, finalMoveData[idx]!.errorTimeClass])
        ),
        movePhases: Object.fromEntries(
            completedIndexes
                .filter(idx => finalMoveData[idx]?.phase)
                .map(idx => [idx, finalMoveData[idx]!.phase])
        ),
        bestMoves: Object.fromEntries(
            completedIndexes
                .filter(idx => evalResults[idx + 1]?.bestMove)
                .map(idx => [idx, evalResults[idx + 1]!.bestMove])
        ),
        alternativeLines: Object.fromEntries(
            completedIndexes
                .filter(idx => evalResults[idx + 1]?.lines)
                .map(idx => [idx, evalResults[idx + 1]!.lines])
        ),
    };

    const movesToSave = completedIndexes.map(idx => {
        const m = finalMoveData[idx];
        if (!m) {
            throw new Error(`finalMoveData[${idx}] is undefined during persistence build`);
        }
        const historyMove = history[idx];
        const san = typeof historyMove === 'string' ? historyMove : historyMove.san;
        const evalResult = evalResults[idx + 1];

        return {
            ply: idx,
            san,
            evaluation: evalResult?.score,
            label: m.label,
            moveTime: m.moveTime,
            remaining_time: m.remainingTime,
            error_time_class: m.errorTimeClass ?? null,
            // fen: posición DESPUÉS del movimiento (para miniaturas)
            fen: positions[idx + 1] ?? positions[idx],
            // start_fen: posición ANTES del movimiento (para explorador)
            start_fen: positions[idx],
        };
    });

    return { fullData, movesToSave };
}
