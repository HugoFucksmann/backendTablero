'use strict';

/**
 * polyglotBook.js
 * ───────────────
 * Lector de libros de apertura en formato Polyglot (.bin) — 100 % JS puro.
 *
 * Formato de cada entrada (16 bytes, big-endian):
 *   [0–7]   key    : hash Zobrist de 64 bits (Polyglot)
 *   [8–9]   move   : jugada codificada en bits (dest[0-5] orig[6-11] promo[12-14])
 *   [10–11] weight : frecuencia/calidad de la jugada
 *   [12–15] learn  : estadísticas (ignorado)
 *
 * El archivo está ordenado por key ascendente → búsqueda binaria O(log n).
 *
 * Algoritmo de hash (Polyglot / python-chess):
 *   piece_index = (piece_type - 1) * 2 + pivot   (pivot: 0=negras, 1=blancas)
 *   Orden de tipos: P=0 N=1 B=2 R=3 Q=4 K=5  → intercalado bP=0 wP=1 bN=2 wN=3…
 *   Turn: XOR entry[780] cuando es turno de BLANCAS
 *   EP:   solo si hay un peón adyacente que pueda capturar
 *
 * Tabla de números aleatorios: data/poly_random.bin
 *   781 valores × 8 bytes big-endian = 6 248 bytes.
 *   Generada una sola vez con python-chess (misma tabla que usa gm2001.bin).
 *
 * API pública:
 *   PolyglotBook.load()          → void  (llamar una vez al arranque)
 *   PolyglotBook.lookup(chess)   → { uci, weight }[]  (vacío si no está en libro)
 *   PolyglotBook.isBookMove(chess, uci) → boolean
 *   PolyglotBook.loaded          → boolean
 *   PolyglotBook.entryCount      → number
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR       = path.join(__dirname, '..', '..', '..', 'data');
const RANDOM_BIN     = path.join(DATA_DIR, 'poly_random.bin');
const ENTRY_SIZE     = 16;
const PROMO_DECODE   = ['', 'n', 'b', 'r', 'q'];
// chess.js piece type → Polyglot base index (0-based, before ×2+pivot)
const PT = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

// ── Random table ──────────────────────────────────────────────────────────────

let _rndBuf = null;

function _loadRandomTable() {
    if (_rndBuf) return;
    if (!fs.existsSync(RANDOM_BIN)) {
        throw new Error(
            `[PolyglotBook] Tabla de números aleatorios no encontrada: ${RANDOM_BIN}\n` +
            `  Regenerar con: python scripts/gen_poly_random.py`
        );
    }
    _rndBuf = fs.readFileSync(RANDOM_BIN);
}

/** Lee la i-ésima entrada de la tabla random como BigInt de 64 bits. */
function rnd(i) {
    const off = i * 8;
    return (BigInt(_rndBuf.readUInt32BE(off)) << 32n) | BigInt(_rndBuf.readUInt32BE(off + 4));
}

// ── Zobrist hash ──────────────────────────────────────────────────────────────

/**
 * Calcula el hash Polyglot de la posición representada por una instancia de chess.js.
 * @param {import('chess.js').Chess} chess
 * @returns {BigInt}
 */
function computeHash(chess) {
    let h = 0n;

    // 1. Piezas
    const board = chess.board();
    for (let ri = 0; ri < 8; ri++) {
        for (let fi = 0; fi < 8; fi++) {
            const p = board[ri][fi];
            if (!p) continue;
            // Polyglot square: A1=0…H8=63 (rank-major)
            // chess.js board[0] = rank 8 → polyglot rank 7
            const sq      = (7 - ri) * 8 + fi;
            const pivot   = p.color === 'w' ? 1 : 0;
            const pieceIdx = PT[p.type] * 2 + pivot;
            h ^= rnd(pieceIdx * 64 + sq);
        }
    }

    // 2. Enroque
    const parts  = chess.fen().split(' ');
    const castle = parts[2];
    if (castle.includes('K')) h ^= rnd(768);
    if (castle.includes('Q')) h ^= rnd(769);
    if (castle.includes('k')) h ^= rnd(770);
    if (castle.includes('q')) h ^= rnd(771);

    // 3. En passant (solo si hay peón adyacente que pueda capturar)
    const ep = parts[3];
    if (ep !== '-') {
        const epFile = ep.charCodeAt(0) - 97; // a=0
        const epRank = parseInt(ep[1], 10) - 1; // 0-indexed
        const isWhiteTurn = chess.turn() === 'w';
        // Buscar peones blancos/negros adyacentes al cuadrado EP
        const pawnRank = isWhiteTurn ? epRank - 1 : epRank + 1;
        let hasPawn = false;
        for (const df of [-1, 1]) {
            const f = epFile + df;
            if (f < 0 || f > 7) continue;
            const adjRi  = 7 - pawnRank;
            if (adjRi < 0 || adjRi > 7) continue;
            const cell = board[adjRi]?.[f];
            if (cell && cell.type === 'p' && cell.color === chess.turn()) {
                hasPawn = true;
                break;
            }
        }
        if (hasPawn) h ^= rnd(772 + epFile);
    }

    // 4. Turno (XOR entry[780] cuando juegan BLANCAS)
    if (chess.turn() === 'w') h ^= rnd(780);

    return h;
}

// ── Binary search en el .bin ──────────────────────────────────────────────────

function readKey(buf, offset) {
    return (BigInt(buf.readUInt32BE(offset)) << 32n) | BigInt(buf.readUInt32BE(offset + 4));
}

function decodeMove(word) {
    const toSq   = word & 0x3F;
    const fromSq = (word >> 6) & 0x3F;
    const promoId = (word >> 12) & 0x7;
    const files  = 'abcdefgh';
    const uci    = files[fromSq % 8] + (Math.floor(fromSq / 8) + 1) +
                   files[toSq   % 8] + (Math.floor(toSq   / 8) + 1) +
                   (PROMO_DECODE[promoId] || '');
    return uci;
}

function findByKey(buf, key, totalEntries) {
    let lo = 0, hi = totalEntries - 1, first = -1;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const k   = readKey(buf, mid * ENTRY_SIZE);
        if (k === key)    { first = mid; hi = mid - 1; }
        else if (k < key) lo = mid + 1;
        else              hi = mid - 1;
    }

    if (first === -1) return [];

    const moves = [];
    for (let i = first; i < totalEntries; i++) {
        const off = i * ENTRY_SIZE;
        if (readKey(buf, off) !== key) break;
        const word   = buf.readUInt16BE(off + 8);
        const weight = buf.readUInt16BE(off + 10);
        moves.push({ uci: decodeMove(word), weight });
    }

    // Mejor movimiento primero
    moves.sort((a, b) => b.weight - a.weight);
    return moves;
}

// ── Clase principal ───────────────────────────────────────────────────────────

class PolyglotBookClass {
    constructor() {
        this._buf    = null;
        this._size   = 0;
        this._loaded = false;
    }

    get loaded()     { return this._loaded; }
    get entryCount() { return this._size; }

    /**
     * Carga el archivo .bin en memoria.
     * @param {string} binPath  Ruta al archivo .bin (ej: data/gm2001.bin)
     */
    load(binPath) {
        if (this._loaded) return;

        _loadRandomTable();

        if (!fs.existsSync(binPath)) {
            console.warn(`[PolyglotBook] Archivo no encontrado: ${binPath}`);
            return;
        }

        this._buf    = fs.readFileSync(binPath);
        this._size   = Math.floor(this._buf.length / ENTRY_SIZE);
        this._loaded = true;

        console.log(
            `[PolyglotBook] Cargado: ${path.basename(binPath)} ` +
            `(${this._size.toLocaleString()} entradas)`
        );
    }

    /**
     * Devuelve todos los movimientos del libro para la posición actual.
     * @param {import('chess.js').Chess} chess
     * @returns {{ uci: string, weight: number }[]}
     */
    lookup(chess) {
        if (!this._loaded) return [];
        const key = computeHash(chess);
        return findByKey(this._buf, key, this._size);
    }

    /**
     * Verifica si una jugada UCI específica está en el libro para la posición.
     * @param {import('chess.js').Chess} chess
     * @param {string} uci  Jugada en formato UCI (ej: "e2e4")
     * @returns {boolean}
     */
    isBookMove(chess, uci) {
        return this.lookup(chess).some(m => m.uci === uci);
    }
}

/** Singleton — compartido en todo el proceso. */
const PolyglotBook = new PolyglotBookClass();

module.exports = { PolyglotBook, computePolyglotHash: computeHash };
