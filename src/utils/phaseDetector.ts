export const OPENING_PLY_THRESHOLD = 14;      // 7 jugadas completas
export const ENDGAME_MATERIAL_THRESHOLD = 13; // sin peones, por bando

/** Calcula el material no-peón de un bando leyendo la FEN */
function _materialFor(fen: string, isWhite: boolean): number {
    const piecePart = fen.split(' ')[0];
    const pieces = isWhite
        ? piecePart.replace(/[^RNBQ]/g, '')   // mayúsculas = blancas
        : piecePart.replace(/[^rnbq]/g, '');   // minúsculas = negras

    const VALUES: Record<string, number> = { R: 5, r: 5, N: 3, n: 3, B: 3, b: 3, Q: 9, q: 9 };
    let total = 0;
    for (const p of pieces) {
        total += VALUES[p] ?? 0;
    }
    return total;
}

export type GamePhase = 'Apertura' | 'Medio Juego' | 'Final';

export const PhaseDetector = {
    /**
     * @param ply       - Índice de jugada (0-based)
     * @param fen       - FEN de la posición ANTES de la jugada
     * @param isBook   - Si la jugada fue clasificada como libro
     */
    detect(ply: number, fen: string, isBook: boolean): GamePhase {
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
