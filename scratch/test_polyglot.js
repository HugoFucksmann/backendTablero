'use strict';
const path = require('path');
const { PolyglotBook } = require('../src/services/openings/polyglotBook');
const { Chess } = require('chess.js');

PolyglotBook.load(path.join(__dirname, '..', 'data', 'gm2001.bin'));
console.log('Loaded:', PolyglotBook.loaded, '| Entries:', PolyglotBook.entryCount);

// Ruy López: 1.e4 e5 2.Nf3 Nc6 3.Bb5
const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'];
const c = new Chess();

for (const san of moves) {
    const bookMoves = PolyglotBook.lookup(c);
    c.move(san);
    const last = c.history({ verbose: true }).at(-1);
    const uci = last.from + last.to + (last.promotion || '');
    const inBook = bookMoves.some(m => m.uci === uci);
    const top3 = bookMoves.slice(0, 3).map(m => m.uci + '(' + m.weight + ')').join(', ');
    console.log(san + ' (' + uci + '): ' + (inBook ? 'BOOK' : 'NOT BOOK') + ' | opciones: ' + top3);
}

// Test con Siciliana: 1.e4 c5
const c2 = new Chess();
const bm = PolyglotBook.lookup(c2);
console.log('\nPosicion inicial - movimientos en libro:');
bm.forEach(m => console.log('  ' + m.uci + ' weight=' + m.weight));
