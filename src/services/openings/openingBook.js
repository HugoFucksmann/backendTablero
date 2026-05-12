'use strict';

/**
 * openingBook.js
 * ──────────────
 * Responsibility: Load and query the local opening book.
 *
 * Data source: Lichess official TSV files (a.tsv → e.tsv) in ./data/
 * Format per row: eco \t name \t pgn
 *
 * Startup: parse all TSVs once, replay each PGN with chess.js to obtain the
 * final FEN (stripped to 4 fields), and store it in a Map.
 * All queries are O(1) thereafter — zero I/O, zero async.
 *
 * Public API:
 *   OpeningBook.load()           → void  (call once at server startup)
 *   OpeningBook.lookup(fen)      → { eco, name, rootName } | null
 *   OpeningBook.findLastKnown(positions, upToPly) → { entry, ply, movesBack }
 *   OpeningBook.size             → number of entries loaded
 */

const fs   = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

// En la nueva estructura, data/ está en la raíz del proyecto
const DATA_DIR   = path.join(__dirname, '..', '..', '..', 'data');
const TSV_FILES  = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'];
const MAX_BACK   = 10; // maximum plies to search backwards in findLastKnown

/**
 * Normalizes a FEN to a 4-field key, letting chess.js fix the en passant
 * square. Chess.com omits the en passant square when no capture is possible;
 * chess.js (and the TSV data) may write it differently. Round-tripping through
 * chess.js canonicalizes the field so keys always match.
 */
function normalizeFen(fen) {
    try {
        const chess = new Chess(fen);
        return chess.fen().split(' ').slice(0, 4).join(' ');
    } catch {
        // Fallback: strip clock fields without normalization
        return fen.split(' ').slice(0, 4).join(' ');
    }
}

/** Extracts the root name (before the first ":") from a full opening name. */
function rootName(name) {
    const idx = name.indexOf(':');
    return idx !== -1 ? name.slice(0, idx).trim() : name;
}


class OpeningBookClass {
    constructor() {
        /** @type {Map<string, {eco: string, name: string, rootName: string}>} */
        this._map  = new Map();
        this._loaded = false;
    }

    // ── Initialization ────────────────────────────────────────────────────────

    /**
     * Parses all TSV files and builds the in-memory Map.
     * Must be called once before any lookups.
     * Synchronous — runs at server startup, not in the request path.
     */
    load() {
        if (this._loaded) return;

        let parsedEntries = 0;

        for (const file of TSV_FILES) {
            const filePath = path.join(DATA_DIR, file);

            if (!fs.existsSync(filePath)) {
                console.warn(`[OpeningBook] Missing TSV file: ${filePath}`);
                continue;
            }

            const lines = fs.readFileSync(filePath, 'utf8').split('\n');

            for (const line of lines) {
                if (!line.trim() || line.startsWith('eco')) continue;

                const parts = line.split('\t');
                if (parts.length < 3) continue;

                const [eco, name, pgn] = parts;
                if (!pgn?.trim()) continue;

                try {
                    const chess = new Chess();
                    const entry = {
                        eco:      eco.trim(),
                        name:     name.trim(),
                        rootName: rootName(name.trim()),
                        moves:    [] // To store child moves from this position in the dataset
                    };

                    // Parse moves from the PGN manually to step through them
                    chess.loadPgn(pgn.trim());
                    const history = chess.history({ verbose: true });

                    // Replay from scratch, storing each intermediate FEN and the move that follows it
                    const replay = new Chess();
                    for (const move of history) {
                        const fenBefore = normalizeFen(replay.fen());
                        const san = move.san;
                        const uci = move.from + move.to + (move.promotion || '');

                        // Store the opening name/eco for the position AFTER the move
                        replay.move(move);
                        const fenAfter = normalizeFen(replay.fen());

                        // 1. Index the opening info for the resulting position
                        // We always overwrite so later (more specific) entries win.
                        if (!this._map.has(fenAfter)) {
                            this._map.set(fenAfter, { ...entry, nextMoves: new Map() });
                        } else {
                            const existing = this._map.get(fenAfter);
                            existing.eco = entry.eco;
                            existing.name = entry.name;
                            existing.rootName = entry.rootName;
                        }

                        // 2. Index the move that leads from fenBefore to fenAfter
                        if (!this._map.has(fenBefore)) {
                            this._map.set(fenBefore, { eco: '', name: '', rootName: '', nextMoves: new Map() });
                        }
                        const beforeEntry = this._map.get(fenBefore);
                        if (!beforeEntry.nextMoves.has(san)) {
                            beforeEntry.nextMoves.set(san, { san, uci, count: 0 });
                        }
                        beforeEntry.nextMoves.get(san).count++;
                    }

                    parsedEntries++;
                } catch (err) {
                    // Malformed PGN — skip silently
                }
            }
        }

        this._loaded = true;
        console.log(
            `[OpeningBook] Loaded ${this._map.size} unique positions ` +
            `from ${parsedEntries} opening lines.`
        );
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    /** @returns {number} Number of positions in the book. */
    get size() { return this._map.size; }

    /**
     * Looks up a position by FEN.
     * @param {string} fen  Full FEN or 4-field FEN key
     * @returns {{ eco: string, name: string, rootName: string } | null}
     */
    lookup(fen) {
        const data = this._map.get(normalizeFen(fen));
        if (!data) return null;
        return { eco: data.eco, name: data.name, rootName: data.rootName };
    }

    /**
     * Returns available moves from the book for a given FEN.
     * @param {string} fen 
     * @returns {Array<{san: string, uci: string, count: number}>}
     */
    getMoves(fen) {
        const data = this._map.get(normalizeFen(fen));
        if (!data || !data.nextMoves) return [];
        return Array.from(data.nextMoves.values()).sort((a, b) => b.count - a.count);
    }

    /**
     * Finds the last known opening position at or before `upToPly`.
     */
    findLastKnown(positions, upToPly) {
        const limit = Math.max(0, upToPly - MAX_BACK);

        for (let ply = upToPly; ply >= limit; ply--) {
            if (!positions[ply]) continue;
            const entry = this.lookup(positions[ply]);
            if (entry && entry.name) {
                return { entry, ply, movesBack: upToPly - ply };
            }
        }

        return { entry: null, ply: -1, movesBack: upToPly };
    }
}

/** Singleton instance — shared across the entire process. */
const OpeningBook = new OpeningBookClass();

module.exports = { OpeningBook };
