'use strict';

const fetch = global.fetch || require('node-fetch');
const { OpeningBook } = require('./openingBook');

const MAX_BOOK_PLY = 30;
const MIN_THEORY_GAMES = 230_000;
const MAX_MOVE_RANK = 6;
const LICHESS_DELAY_MS = 600;
const LICHESS_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_NONBOOK = 2;
const RATINGS_PARAM = '1800,2000,2200,2500';

const openingCache = new Map();
const MAX_CACHE_SIZE = 100;

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

const OpeningService = {
    async detectOpenings({ positions, history, gameId, token, signal, onPlyResolved, onOpeningDetected }) {
        if (openingCache.has(gameId)) {
            console.log(`[Opening] Using cache for gameId: ${gameId}`);
            const cache = openingCache.get(gameId);
            const cachedBookPlies = cache.bookPlies instanceof Set
                ? cache.bookPlies
                : new Set(cache.bookPlies);
            for (let i = 0; i < history.length; i++) onPlyResolved(i, cachedBookPlies.has(i));
            onOpeningDetected?.({ ...cache, bookPlies: cachedBookPlies });
            return;
        }

        console.log(`[Opening] Fetching from Lichess for gameId: ${gameId}`);

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

            const fenAfter = positions[ply + 1];
            const localEntry = OpeningBook.lookup(fenAfter);

            if (localEntry) {
                finalOpeningName = localEntry.name;
                finalEcoCode = localEntry.eco;
                bookPlies.add(ply);
                lastTheoryPly = ply;
                consecutiveNonBook = 0;
                onPlyResolved(ply, true);
                continue;
            }

            const fenBeforeMove = positions[ply].split(' ').slice(0, 4).join(' ');
            const url = `https://explorer.lichess.ovh/lichess?fen=${encodeURIComponent(fenBeforeMove)}&ratings=${RATINGS_PARAM}`;
            const headers = { 'User-Agent': 'ChessAnalysisLocalApp/1.0', 'Accept': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            let retries = 2;
            let success = false;

            while (retries >= 0 && !success && !signal?.aborted) {
                try {
                    const res = await fetchWithTimeout(url, { headers }, LICHESS_TIMEOUT_MS);
                    if (res.status === 429) {
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

                    const moveObj = history[ply];
                    const playedUci = typeof moveObj === 'string' ? moveObj : moveObj.lan;
                    if (!playedUci) {
                        consecutiveNonBook++;
                        onPlyResolved(ply, false);
                        success = true;
                        continue;
                    }
                    const explorerIdx = data.moves?.findIndex(m => m.uci === playedUci) ?? -1;

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
                    if (err.name === 'AbortError' || signal?.aborted) break;
                    retries--;
                    if (retries >= 0) await delay(2000);
                    else {
                        for (let i = ply; i < maxPly; i++) onPlyResolved(i, false);
                        success = true;
                        consecutiveNonBook = MAX_CONSECUTIVE_NONBOOK;
                    }
                }
            }

            if (!success) {
                for (let i = ply; i < maxPly; i++) onPlyResolved(i, false);
                break;
            }
        }

        if (!signal?.aborted) {
            const result = { openingName: finalOpeningName, ecoCode: finalEcoCode, openingPly: lastTheoryPly, bookPlies };
            if (openingCache.size >= MAX_CACHE_SIZE) openingCache.delete(openingCache.keys().next().value);
            openingCache.set(gameId, result);
            onOpeningDetected?.(result);
        }
    },

    clearCache(gameId) {
        if (gameId) {
            openingCache.delete(gameId);
            console.log(`[Opening] Cache cleared for gameId: ${gameId}`);
        } else {
            openingCache.clear();
            console.log(`[Opening] All cache cleared`);
        }
    }
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { OpeningService, MAX_BOOK_PLY };