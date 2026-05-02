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

const DATA_DIR   = path.join(__dirname, 'data');
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
        let indexedPositions = 0;

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

                // Replay the PGN move-by-move and index EVERY intermediate position.
                // This is the key fix: a player who plays e.g. "1.e4 e5 2.Nf3" should
                // have ALL three positions recognized, not just the one that ends a named
                // variation. Without this, only positions that happen to be the final
                // move of some TSV entry are indexed.
                try {
                    const chess = new Chess();
                    const entry = {
                        eco:      eco.trim(),
                        name:     name.trim(),
                        rootName: rootName(name.trim()),
                    };

                    // Parse moves from the PGN manually to step through them
                    // chess.js loadPgn then history() is the safest approach
                    chess.loadPgn(pgn.trim());
                    const moves = chess.history();

                    // Replay from scratch, storing each intermediate FEN
                    const replay = new Chess();
                    for (const san of moves) {
                        replay.move(san);
                        // Use normalizeFen so the en passant square is
                        // canonical — chess.js only writes e.g. 'e3' when a
                        // pawn can actually capture, avoiding false misses.
                        const key = normalizeFen(replay.fen());

                        // For each intermediate position, keep the most specific entry.
                        // "Most specific" = the entry whose PGN is longest (last to
                        // write wins, since TSV rows are ordered general→specific).
                        // We always overwrite so later (more specific) entries win.
                        if (!this._map.has(key)) indexedPositions++;
                        this._map.set(key, entry);
                    }

                    parsedEntries++;
                } catch {
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
        return this._map.get(normalizeFen(fen)) ?? null;
    }

    /**
     * Finds the last known opening position at or before `upToPly`.
     *
     * Walks backwards from `upToPly` up to MAX_BACK steps until it finds a
     * position that exists in the book.
     *
     * @param {string[]} positions  Array of FENs indexed by ply (positions[0] = start)
     * @param {number}   upToPly   The current ply (0-indexed)
     * @returns {{ entry: object|null, ply: number, movesBack: number }}
     *          `entry` is null if no book position was found within MAX_BACK.
     */
    findLastKnown(positions, upToPly) {
        const limit = Math.max(0, upToPly - MAX_BACK);

        for (let ply = upToPly; ply >= limit; ply--) {
            if (!positions[ply]) continue;
            const entry = this.lookup(positions[ply]);
            if (entry) {
                return { entry, ply, movesBack: upToPly - ply };
            }
        }

        return { entry: null, ply: -1, movesBack: upToPly };
    }
}

/** Singleton instance — shared across the entire process. */
const OpeningBook = new OpeningBookClass();

module.exports = { OpeningBook };
