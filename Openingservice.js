'use strict';

/**
 * OpeningService (server-side)
 * ────────────────────────────
 * Mirror of the browser openingService.js.
 * Queries the Lichess Opening Explorer for each ply up to MAX_BOOK_PLY.
 *
 * Differences from the browser version:
 *  - Uses Node's built-in `fetch` (Node 18+) or `node-fetch` as fallback.
 *  - Opening results are stored in the shared PositionCache (openingCache tier).
 */

const MAX_BOOK_PLY = 30;
const MIN_THEORY_GAMES = 230_000;
const MAX_MOVE_RANK = 6;
const LICHESS_DELAY_MS = 400;
const LICHESS_TIMEOUT_MS = 6_000;
const MAX_CONSECUTIVE_NONBOOK = 2;

const RATINGS_PARAM = '1800,2000,2200,2500';

// Node 18+ has global fetch; older versions need node-fetch
const _fetch = globalThis.fetch ?? require('node-fetch');

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal
        ? AbortSignal.any
            ? AbortSignal.any([options.signal, controller.signal])
            : options.signal                // fallback: prefer caller signal
        : controller.signal;

    try {
        return await _fetch(url, { ...options, signal });
    } finally {
        clearTimeout(tid);
    }
}

const OpeningService = {
    /**
     * @param {object} opts
     * @param {string[]} opts.positions     - FEN array (length = history.length + 1)
     * @param {object[]} opts.history       - move objects with .lan
     * @param {string}   opts.gameId
     * @param {string}   [opts.token]       - Lichess OAuth token
     * @param {AbortSignal} [opts.signal]
     * @param {PositionCache} opts.cache
     * @param {Function} opts.onPlyResolved - (ply, isBook) => void
     * @param {Function} [opts.onOpeningDetected]
     */
    async detectOpenings({ positions, history, gameId, token, signal, cache, onPlyResolved, onOpeningDetected }) {
        // Cache hit
        const cached = cache?.getOpening(gameId);
        if (cached) {
            for (let i = 0; i < history.length; i++) onPlyResolved(i, cached.bookPlies.has(i));
            onOpeningDetected?.({
                openingName: cached.openingName,
                ecoCode: cached.ecoCode,
                openingPly: cached.openingPly,
                bookPlies: cached.bookPlies,
            });
            return;
        }

        const maxPly = Math.min(history.length, MAX_BOOK_PLY);
        const bookPlies = new Set();
        let consecutiveNonBook = 0;
        let finalOpeningName = '';
        let finalEcoCode = '';
        let lastTheoryPly = -1;

        for (let ply = 0; ply < maxPly; ply++) {
            if (signal?.aborted) break;

            if (consecutiveNonBook >= MAX_CONSECUTIVE_NONBOOK) {
                for (let i = ply; i < maxPly; i++) onPlyResolved(i, false);
                break;
            }

            const fenBeforeMove = positions[ply].split(' ').slice(0, 4).join(' ');
            const url = `https://explorer.lichess.ovh/lichess?fen=${encodeURIComponent(fenBeforeMove)}&ratings=${RATINGS_PARAM}`;
            const headers = token ? { Authorization: `Bearer ${token}` } : {};

            let retries = 2;
            let success = false;

            while (retries >= 0 && !success && !signal?.aborted) {
                try {
                    const res = await fetchWithTimeout(url, { headers, signal }, LICHESS_TIMEOUT_MS);

                    if (res.status === 429) {
                        console.warn(`[Opening] 429 at ply ${ply}, retrying…`);
                        retries--;
                        if (retries >= 0) await delay(3000);
                        continue;
                    }

                    if (!res.ok) throw new Error(`HTTP ${res.status}`);

                    const data = await res.json();

                    if (data.opening?.name) {
                        finalOpeningName = data.opening.name;
                        finalEcoCode = data.opening.eco ?? finalEcoCode;
                    }

                    const playedUci = history[ply].lan;
                    const explorerIdx = data.moves.findIndex(m => m.uci === playedUci);

                    if (explorerIdx > -1 && explorerIdx < MAX_MOVE_RANK) {
                        const m = data.moves[explorerIdx];
                        const games = (m.white || 0) + (m.draw || m.draws || 0) + (m.black || 0);

                        if (games >= MIN_THEORY_GAMES) {
                            bookPlies.add(ply);
                            lastTheoryPly = ply;
                            consecutiveNonBook = 0;
                            onPlyResolved(ply, true);
                        } else {
                            consecutiveNonBook++;
                            onPlyResolved(ply, false);
                        }
                    } else {
                        consecutiveNonBook++;
                        onPlyResolved(ply, false);
                    }

                    success = true;

                    if (consecutiveNonBook < MAX_CONSECUTIVE_NONBOOK && ply < maxPly - 1) {
                        await delay(LICHESS_DELAY_MS);
                    }

                } catch (err) {
                    if (err.name === 'AbortError') break;
                    console.warn(`[Opening] Error at ply ${ply}:`, err.message);
                    for (let i = ply; i < maxPly; i++) onPlyResolved(i, false);
                    success = true;
                    consecutiveNonBook = MAX_CONSECUTIVE_NONBOOK;
                    break;
                }
            }

            if (!success) {
                for (let i = ply; i < maxPly; i++) onPlyResolved(i, false);
                break;
            }
        }

        if (!signal?.aborted) {
            cache?.setOpening(gameId, { bookPlies, openingName: finalOpeningName, ecoCode: finalEcoCode, openingPly: lastTheoryPly });
            onOpeningDetected?.({ openingName: finalOpeningName, ecoCode: finalEcoCode, openingPly: lastTheoryPly, bookPlies });
        }
    },
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { OpeningService, MAX_BOOK_PLY };