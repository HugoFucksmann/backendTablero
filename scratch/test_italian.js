'use strict';
/**
 * Test: Italian Game / Giuoco Pianissimo
 * Variante: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5
 * Pregunta: ¿está d3 (d2d3) en el libro después de esas jugadas?
 */
const path = require('path');
const { PolyglotBook } = require('../src/services/openings/polyglotBook');
const { Chess } = require('chess.js');

PolyglotBook.load(path.join(__dirname, '..', 'data', 'gm2001.bin'));

const mainLine = [
    { white: 'e4',  black: 'e5'  },
    { white: 'Nf3', black: 'Nc6' },
    { white: 'Bc4', black: 'Bc5' },
];

const c = new Chess();

console.log('=== Italian Game: Giuoco Piano → Pianissimo ===\n');

for (const pair of mainLine) {
    // Turno blancas
    const bmW = PolyglotBook.lookup(c);
    c.move(pair.white);
    const lastW = c.history({ verbose: true }).at(-1);
    const uciW  = lastW.from + lastW.to;
    const inBookW = bmW.some(m => m.uci === uciW);
    console.log('Blancas ' + pair.white + ' (' + uciW + '): ' + (inBookW ? '✓ en libro' : '✗ fuera'));

    // Turno negras
    const bmB = PolyglotBook.lookup(c);
    c.move(pair.black);
    const lastB = c.history({ verbose: true }).at(-1);
    const uciB  = lastB.from + lastB.to;
    const inBookB = bmB.some(m => m.uci === uciB);
    console.log('Negras  ' + pair.black + ' (' + uciB + '): ' + (inBookB ? '✓ en libro' : '✗ fuera'));
}

// Posición después de 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — turno blancas
console.log('\n--- Posición actual (turno blancas): ' + c.fen().split(' ')[0] + ' ---');
const bookMoves = PolyglotBook.lookup(c);
console.log('Movimientos en libro (' + bookMoves.length + '):');
if (bookMoves.length === 0) {
    console.log('  (ninguno — posición fuera del libro)');
} else {
    bookMoves.forEach((m, i) => {
        // Decodificar a SAN para que sea legible
        const tmp = new Chess(c.fen());
        let san = m.uci;
        try {
            const r = tmp.move({ from: m.uci.slice(0,2), to: m.uci.slice(2,4), promotion: m.uci[4] });
            san = r.san;
        } catch {}
        const isD3 = m.uci === 'd2d3';
        console.log('  ' + (i+1) + '. ' + san + ' (' + m.uci + ')  weight=' + m.weight + (isD3 ? '  ← d3 PIANISSIMO ✓' : ''));
    });
}

// ¿Está específicamente d2d3?
const d3InBook = bookMoves.some(m => m.uci === 'd2d3');
console.log('\n¿d3 (Giuoco Pianissimo) en el libro?: ' + (d3InBook ? 'SÍ ✓' : 'NO ✗'));
