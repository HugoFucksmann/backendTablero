import { Chess } from 'chess.js';
import { ChessMath } from '../../utils/chessMath.js';

export interface TensionResult {
    tensionIndex: number;
    attackedSquaresCount: number;
}

export interface OnlyMoveResult {
    isOnlyMove: boolean;
    criticalityGap: number;
    discard?: boolean;
}

export const DataMiner = {
    /**
     * Calcula la severidad del error ponderada por la posición final.
     * Un error que te deja en posición perdedora (wpAfter cercano a 0) se castiga más.
     */
    calculateBlunderSeverity(wpBefore: number, wpAfter: number, isWhiteTurn: boolean): number {
        const solverWpBefore = isWhiteTurn ? wpBefore : 1 - wpBefore;
        const solverWpAfter = isWhiteTurn ? wpAfter : 1 - wpAfter;
        const wpLoss = Math.max(0, solverWpBefore - solverWpAfter);
        
        // Ponderar por qué tan mala es la posición final
        return Number((wpLoss * (1 - solverWpAfter)).toFixed(4));
    },

    /**
     * Escanea el FEN y devuelve métricas de complejidad/tensión.
     */
    calculateTension(fen: string): TensionResult {
        try {
            const chess = new Chess(fen);
            const moves = chess.moves({ verbose: true });
            let tension = 0;
            const attackedSquares = new Set<string>();
            
            for (const m of moves) {
                if (m.flags.includes('c') || m.flags.includes('e')) {
                    tension++;
                    attackedSquares.add(m.to);
                }
            }
            return {
                tensionIndex: tension,
                attackedSquaresCount: attackedSquares.size
            };
        } catch {
            return { tensionIndex: 0, attackedSquaresCount: 0 };
        }
    },

    /**
     * Determina si la línea principal es un 'Only Move' comparando con la segunda mejor.
     */
    detectOnlyMove(
        line1: { score?: number; mate?: number | null } | null | undefined,
        line2: { score?: number; mate?: number | null } | null | undefined,
        isWhiteTurn: boolean
    ): OnlyMoveResult {
        if (!line1) {
            return { isOnlyMove: false, criticalityGap: 0, discard: true };
        }

        const wp1 = ChessMath.cpToWhiteWinProb(line1.score ?? 0, line1.mate ?? null, !isWhiteTurn);
        const solverWp1 = isWhiteTurn ? wp1 : 1 - wp1;

        // Si no hay segunda línea legal, es jugada única legal
        if (!line2) {
            // Regla de negocio 2: Solo es Only Move si la única jugada legal mantiene una posición ganadora o salvable (> 0.45)
            // Si la única jugada legal es un desastre (solverWp1 <= 0.45), descartamos el puzzle.
            if (solverWp1 > 0.45) {
                return { isOnlyMove: true, criticalityGap: 1.0 };
            } else {
                return { isOnlyMove: false, criticalityGap: 0, discard: true };
            }
        }
        
        const wp2 = ChessMath.cpToWhiteWinProb(line2.score ?? 0, line2.mate ?? null, !isWhiteTurn);
        const solverWp2 = isWhiteTurn ? wp2 : 1 - wp2;
        
        const gap = solverWp1 - solverWp2;
        
        // Es un Only Move si la mejor jugada mantiene ventaja (>50%) y la segunda pierde (<30%)
        const isOnlyMove = solverWp1 > 0.50 && solverWp2 < 0.30 && gap > 0.30;
        
        return {
            isOnlyMove,
            criticalityGap: Number(gap.toFixed(4))
        };
    },

    /**
     * Identifica patrones tácticos básicos en la secuencia del puzzle.
     */
    extractTacticalMotifs(fen: string, sequence: string[]): string[] {
        const motifs = new Set<string>();
        if (!fen || !sequence || sequence.length === 0) return [];
        
        try {
            const chess = new Chess(fen);
            const firstMove = chess.move(sequence[0]);
            
            if (!firstMove) return [];

            if (firstMove.flags.includes('c') || firstMove.flags.includes('e')) motifs.add('capture');
            if (firstMove.flags.includes('p')) motifs.add('promotion');
            
            if (chess.inCheck()) {
                motifs.add('check');
            }
            
            if (chess.isCheckmate()) {
                motifs.add('mate');
            }

            return Array.from(motifs);
        } catch {
            return Array.from(motifs);
        }
    }
};
