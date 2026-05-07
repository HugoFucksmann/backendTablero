'use strict';

const { Chess } = require('chess.js');
const { ChessMath } = require('../../utils/chessMath');

const DataMiner = {
    /**
     * Calcula la severidad del error ponderada por la posición final.
     * Un error que te deja en posición perdedora (wpAfter cercano a 0) se castiga más.
     */
    calculateBlunderSeverity(wpBefore, wpAfter, isWhiteTurn) {
        const solverWpBefore = isWhiteTurn ? wpBefore : 1 - wpBefore;
        const solverWpAfter = isWhiteTurn ? wpAfter : 1 - wpAfter;
        const wpLoss = Math.max(0, solverWpBefore - solverWpAfter);
        
        // Ponderar por qué tan mala es la posición final
        return Number((wpLoss * (1 - solverWpAfter)).toFixed(4));
    },

    /**
     * Escanea el FEN y devuelve métricas de complejidad/tensión.
     */
    calculateTension(fen) {
        try {
            const chess = new Chess(fen);
            const moves = chess.moves({ verbose: true });
            let tension = 0;
            const attackedSquares = new Set();
            
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
    detectOnlyMove(line1Score, line2Score, isWhiteTurn) {
        if (line1Score === undefined || line1Score === null || line2Score === undefined || line2Score === null) {
            return { isOnlyMove: false, criticalityGap: 0 };
        }
        
        const wp1 = ChessMath.cpToWhiteWinProb(line1Score, null, !isWhiteTurn);
        const wp2 = ChessMath.cpToWhiteWinProb(line2Score, null, !isWhiteTurn);
        
        const solverWp1 = isWhiteTurn ? wp1 : 1 - wp1;
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
    extractTacticalMotifs(fen, sequence) {
        const motifs = new Set();
        if (!fen || !sequence || sequence.length === 0) return [];
        
        try {
            const chess = new Chess(fen);
            const firstMove = chess.move(sequence[0], { sloppy: true });
            
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

module.exports = { DataMiner };
