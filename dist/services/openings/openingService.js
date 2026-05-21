import { OpeningBook } from './openingBook.js';
export const MAX_BOOK_PLY = 30;
const openingCache = new Map();
const MAX_CACHE_SIZE = 100;
async function detectOpeningsLocalTSV({ positions, history, gameId, signal, onPlyResolved, onOpeningDetected }) {
    if (openingCache.has(gameId)) {
        const cache = openingCache.get(gameId);
        const cachedBookPlies = cache.bookPlies instanceof Set
            ? cache.bookPlies : new Set(cache.bookPlies);
        (async () => {
            for (let i = 0; i < history.length; i++) {
                if (signal?.aborted)
                    break;
                onPlyResolved(i, cachedBookPlies.has(i));
                if (i % 10 === 0) {
                    await new Promise(r => setImmediate(r));
                }
            }
            if (!signal?.aborted) {
                onOpeningDetected?.({ ...cache, bookPlies: cachedBookPlies });
            }
        })();
        return;
    }
    console.log(`[Opening] Modo TSV Local | Analizando gameId=${gameId}`);
    const maxPly = Math.min(history.length, MAX_BOOK_PLY);
    const bookPlies = new Set();
    let finalOpeningName = '';
    let finalEcoCode = '';
    let lastTheoryPly = -1;
    for (let ply = 0; ply < maxPly; ply++) {
        if (signal?.aborted)
            break;
        const fenAfter = positions[ply + 1];
        if (!fenAfter) {
            onPlyResolved(ply, false);
            continue;
        }
        const localEntry = OpeningBook.lookup(fenAfter);
        if (localEntry && localEntry.name) {
            finalOpeningName = localEntry.rootName || localEntry.name;
            finalEcoCode = localEntry.eco;
            bookPlies.add(ply);
            lastTheoryPly = ply;
            onPlyResolved(ply, true);
        }
        else {
            onPlyResolved(ply, false);
        }
    }
    if (!signal?.aborted) {
        const result = {
            openingName: finalOpeningName || 'Desconocida',
            ecoCode: finalEcoCode || '',
            openingPly: lastTheoryPly,
            bookPlies
        };
        if (openingCache.size >= MAX_CACHE_SIZE) {
            const firstKey = openingCache.keys().next().value;
            if (firstKey !== undefined) {
                openingCache.delete(firstKey);
            }
        }
        openingCache.set(gameId, result);
        onOpeningDetected?.(result);
    }
}
export const OpeningService = {
    /**
     * Punto de entrada único para detección de aperturas.
     * Ahora siempre utiliza el modo TSV local.
     */
    async detectOpenings(params) {
        return detectOpeningsLocalTSV(params);
    },
    clearCache(gameId) {
        if (gameId) {
            openingCache.delete(gameId);
            console.log(`[Opening] Cache cleared for gameId: ${gameId}`);
        }
        else {
            openingCache.clear();
            console.log(`[Opening] All cache cleared`);
        }
    },
    /** Devuelve el modo activo (siempre 'tsv'). */
    get source() {
        return 'tsv';
    },
};
