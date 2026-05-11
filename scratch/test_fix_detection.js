'use strict';
/**
 * Test: Bug fix — historia en formato SAN (strings) → d3 debe detectarse como apertura
 * Simula exactamente el flujo de gameAnalysisCoordinator:
 *   parsePgn → history verbose objects  (caso 1)
 *   history SAN strings                  (caso 2)
 */
const path = require('path');
process.env.OPENING_SOURCE = 'polyglot';

const { PolyglotBook }  = require('../src/services/openings/polyglotBook');
const { OpeningBook }   = require('../src/services/openings/openingBook');
const { OpeningService } = require('../src/services/openings/openingService');
const { buildPositions } = require('../src/utils/analysisUtils');
const { Chess }         = require('chess.js');

PolyglotBook.load(path.join(__dirname, '..', 'data', 'gm2001.bin'));

// ── Construir historia de la Italian / Giuoco Pianissimo ──────────────────────
// 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.d3  (Giuoco Pianissimo)
const sanMoves = ['e4','e5','Nf3','Nc6','Bc4','Bc5','d3'];

// Caso 1: historia como strings SAN (el caso que fallaba)
const historySAN = sanMoves;

// Caso 2: historia como verbose objects (como devuelve parsePgn)
const tmpChess = new Chess();
const historyVerbose = sanMoves.map(san => {
    const result = tmpChess.move(san);
    return result; // objeto con .from, .to, .san, .lan, etc.
});

const positions = buildPositions(historySAN);

console.log('=== Test de detección de aperturas (modo Polyglot) ===\n');
console.log('Jugadas:', sanMoves.join(' '));
console.log('Posiciones generadas:', positions.length);
console.log('');

// Función que simula detectOpeningsPolyglot sincronamente para testear
function testDetection(history, label) {
    const MAX_BOOK_PLY = 30;
    const MAX_CONSECUTIVE_NONBOOK = 2;
    const maxPly = Math.min(history.length, MAX_BOOK_PLY);
    const bookPlies = new Set();
    let consecutiveNonBook = 0;
    let lastTheoryPly = -1;

    const chess = new Chess(positions[0]);

    console.log(`--- ${label} ---`);
    for (let ply = 0; ply < maxPly; ply++) {
        if (consecutiveNonBook >= MAX_CONSECUTIVE_NONBOOK) {
            console.log(`  ply ${ply}: BREAK (consecutiveNonBook=${consecutiveNonBook})`);
            break;
        }

        const moveObj = history[ply];

        // Conversión SAN → UCI (el fix)
        let playedUci = null;
        if (typeof moveObj === 'string') {
            const verboseMoves = chess.moves({ verbose: true });
            const match = verboseMoves.find(m => m.san === moveObj);
            if (match) playedUci = match.from + match.to + (match.promotion || '');
        } else if (moveObj) {
            playedUci = moveObj.lan ||
                (moveObj.from && moveObj.to
                    ? moveObj.from + moveObj.to + (moveObj.promotion || '')
                    : null);
        }

        const bookMoves = PolyglotBook.lookup(chess);
        const inBook = playedUci ? bookMoves.some(m => m.uci === playedUci) : false;

        if (inBook) {
            bookPlies.add(ply);
            lastTheoryPly = ply;
            consecutiveNonBook = 0;
        } else {
            consecutiveNonBook++;
        }

        const san = typeof moveObj === 'string' ? moveObj : moveObj.san;
        console.log(`  ply ${ply}: ${san} (${playedUci || '?'}) → ${inBook ? '✓ BOOK' : '✗ not book'} | consecutiveNonBook=${consecutiveNonBook}`);

        // Avanzar tablero
        try {
            if (typeof moveObj === 'string') chess.move(moveObj);
            else chess.move({ from: moveObj.from, to: moveObj.to, promotion: moveObj.promotion });
        } catch { break; }
    }

    console.log(`  → bookPlies: [${[...bookPlies].join(',')}]`);
    console.log(`  → lastTheoryPly: ${lastTheoryPly}`);
    const d3Detected = bookPlies.has(6); // ply 6 = 4.d3 (después de e4 e5 Nf3 Nc6 Bc4 Bc5)
    console.log(`  → d3 detectado como apertura: ${d3Detected ? 'SÍ ✓' : 'NO ✗'}\n`);
    return d3Detected;
}

const r1 = testDetection(historySAN,     'Caso 1: SAN strings (el que fallaba)');
const r2 = testDetection(historyVerbose, 'Caso 2: verbose objects');

console.log('=== RESULTADO FINAL ===');
console.log('SAN strings fix:', r1 ? 'PASS ✓' : 'FAIL ✗');
console.log('verbose objects:', r2 ? 'PASS ✓' : 'FAIL ✗');

// Test handler get_book_moves directamente
console.log('\n=== Test get_book_moves handler ===');
const { PolyglotBook: PB } = require('../src/services/openings/polyglotBook');
const fenAfterBc5 = positions[6]; // FEN después de 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5
console.log('FEN para lookup:', fenAfterBc5.split(' ').slice(0,4).join(' '));
const c2 = new Chess(fenAfterBc5);
const bookMovesAtBc5 = PB.lookup(c2);
const totalW = bookMovesAtBc5.reduce((s,m) => s+m.weight, 0);
console.log('Movimientos disponibles en libro:');
bookMovesAtBc5.forEach(m => {
    const tmp = new Chess(fenAfterBc5);
    let san = m.uci;
    try { san = tmp.move({from:m.uci.slice(0,2),to:m.uci.slice(2,4),promotion:m.uci[4]}).san; } catch {}
    const freq = totalW > 0 ? Math.round(m.weight/totalW*100) : 0;
    console.log(`  ${san} (${m.uci}) weight=${m.weight} freq=${freq}%${m.uci==='d2d3'?' ← PIANISSIMO':''}`)
});
