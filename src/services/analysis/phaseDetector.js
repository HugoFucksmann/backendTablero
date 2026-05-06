'use strict';

/**
 * PhaseDetector
 * ─────────────
 * Responsabilidad única: clasificar cada jugada en una de las tres fases del juego
 * (Apertura, Medio Juego, Final) usando heurísticas basadas en material y plies.
 *
 * Criterios (alineados con roadmap_implementacion.md §2.1):
 *   - APERTURA  : bookStatus[ply] === true  OR  ply < OPENING_PLY_THRESHOLD
 *   - FINAL     : material total (sin peones) del bando que juega ≤ ENDGAME_MATERIAL_THRESHOLD
 *   - MEDIO JUEGO: caso restante
 *
 * El valor de material usa la escala clásica: R=5, B=N=3, Q=9.
 * No se cuentan peones para el umbral de final (son estructurales, no de transición).
 */

const OPENING_PLY_THRESHOLD = 14;      // 7 jugadas completas
const ENDGAME_MATERIAL_THRESHOLD = 13; // sin peones, por bando

/** Calcula el material no-peón de un bando leyendo la FEN */
function _materialFor(fen, isWhite) {
    const piecePart = fen.split(' ')[0];
    const pieces = isWhite
        ? piecePart.replace(/[^RNBQ]/g, '')   // mayúsculas = blancas
        : piecePart.replace(/[^rnbq]/g, '');   // minúsculas = negras

    const VALUES = { R: 5, r: 5, N: 3, n: 3, B: 3, b: 3, Q: 9, q: 9 };
    let total = 0;
    for (const p of pieces) total += VALUES[p] ?? 0;
    return total;
}

const PhaseDetector = {
    /**
     * @param {number} ply       - Índice de jugada (0-based)
     * @param {string} fen       - FEN de la posición ANTES de la jugada
     * @param {boolean} isBook   - Si la jugada fue clasificada como libro
     * @returns {'Apertura'|'Medio Juego'|'Final'}
     */
    detect(ply, fen, isBook) {
        if (isBook || ply < OPENING_PLY_THRESHOLD) return 'Apertura';

        // Para detectar Final, evaluamos ambos bandos
        const whiteM = _materialFor(fen, true);
        const blackM = _materialFor(fen, false);

        if (whiteM <= ENDGAME_MATERIAL_THRESHOLD || blackM <= ENDGAME_MATERIAL_THRESHOLD) {
            return 'Final';
        }

        return 'Medio Juego';
    },
};

module.exports = { PhaseDetector, OPENING_PLY_THRESHOLD, ENDGAME_MATERIAL_THRESHOLD };
