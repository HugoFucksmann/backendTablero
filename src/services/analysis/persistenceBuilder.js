'use strict';

/**
 * PersistenceBuilder
 * ──────────────────
 * Responsabilidad única: construir los objetos que se pasan a GameStore.save.
 *
 * Deriva dos estructuras:
 *   - fullData   : snapshot completo del análisis (posiciones, evaluaciones, líneas…)
 *   - movesToSave: array plano de jugadas con los campos indexados por SQLite
 *
 * No escribe nada a disco. No depende de GameStore.
 */

/**
 * @param {Object} p
 * @param {string}   p.gameId
 * @param {string[]} p.history        - Array de movimientos (string o {san, lan}).
 * @param {string[]} p.positions      - Array de FENs (positions[0] = pos. inicial).
 * @param {Object[]} p.evalResults    - Evaluaciones por posición.
 * @param {Object[]} p.finalMoveData  - Datos clasificados por jugada.
 * @param {Set<number>} p.completedSet - Índices de jugadas ya clasificadas.
 * @param {Object}   p.accuracy       - { white, black }
 * @param {Object}   p.opening        - { name, eco }
 * @param {Object}   p.players        - { white, black }
 * @param {string|null} p.startFen
 *
 * @returns {{ fullData: Object, movesToSave: Object[] }}
 */
function build({
    gameId,
    history,
    positions,
    evalResults,
    finalMoveData,
    completedSet,
    accuracy,
    opening,
    players,
    startFen,
}) {
    const completedIndexes = Array.from(completedSet);

    const fullData = {
        accuracy,
        opening: { name: opening.name, eco: opening.eco },
        players: { white: players.white, black: players.black },
        startFen: startFen || null,
        history: history.map(m => (typeof m === 'string' ? m : (m.lan ?? m.san))),
        positions,
        evaluations: evalResults,
        moveEvaluations: Object.fromEntries(
            completedIndexes
                .filter(idx => finalMoveData[idx]?.label)
                .map(idx => [idx, finalMoveData[idx].label])
        ),
        movePhases: Object.fromEntries(
            completedIndexes
                .filter(idx => finalMoveData[idx]?.phase)
                .map(idx => [idx, finalMoveData[idx].phase])
        ),
        bestMoves: Object.fromEntries(
            completedIndexes
                .filter(idx => evalResults[idx + 1]?.bestMove)
                .map(idx => [idx, evalResults[idx + 1].bestMove])
        ),
        alternativeLines: Object.fromEntries(
            completedIndexes
                .filter(idx => evalResults[idx + 1]?.lines)
                .map(idx => [idx, evalResults[idx + 1].lines])
        ),
    };

    const movesToSave = completedIndexes.map(idx => {
        const m = finalMoveData[idx];
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
            // fen: posición DESPUÉS del movimiento (para miniaturas)
            fen: positions[idx + 1] ?? positions[idx],
            // start_fen: posición ANTES del movimiento (para explorador)
            start_fen: positions[idx],
        };
    });

    return { fullData, movesToSave };
}

module.exports = { build };