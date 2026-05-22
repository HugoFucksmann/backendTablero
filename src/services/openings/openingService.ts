import { OpeningBook } from './openingBook.js';

export const MAX_BOOK_PLY = 30;

export interface DetectedOpeningResult {
    openingName: string;
    ecoCode: string;
    openingPly: number;
    bookPlies: Set<number>;
}

export interface DetectOpeningsParams {
    positions: string[];
    history: any[];
    gameId: string;
    signal?: AbortSignal | null;
    onPlyResolved: (ply: number, isBook: boolean) => void;
    onOpeningDetected?: (result: DetectedOpeningResult) => void;
}

const openingCache = new Map<string, DetectedOpeningResult>();
const MAX_CACHE_SIZE = 100;

async function detectOpeningsLocalTSV({
    positions,
    history,
    gameId,
    signal,
    onPlyResolved,
    onOpeningDetected
}: DetectOpeningsParams): Promise<void> {
    if (openingCache.has(gameId)) {
        const cache = openingCache.get(gameId)!;
        const cachedBookPlies = cache.bookPlies instanceof Set
            ? cache.bookPlies as Set<number> : new Set<number>(cache.bookPlies as any);
        (async () => {
            try {
                for (let i = 0; i < history.length; i++) {
                    if (signal?.aborted) break;
                    onPlyResolved(i, cachedBookPlies.has(i));
                    if (i % 10 === 0) {
                        await new Promise(r => setImmediate(r));
                    }
                }
                if (!signal?.aborted) {
                    onOpeningDetected?.({ ...cache, bookPlies: cachedBookPlies });
                }
            } catch (err: any) {
                console.error('[Opening] Error resolving openings from cache:', err.message);
            }
        })();
        return;
    }

    console.log(`[Opening] Modo TSV Local | Analizando gameId=${gameId}`);

    const maxPly = Math.min(history.length, MAX_BOOK_PLY);
    const bookPlies = new Set<number>();
    let finalOpeningName = '';
    let finalEcoCode = '';
    let lastTheoryPly = -1;

    for (let ply = 0; ply < maxPly; ply++) {
        if (signal?.aborted) break;

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
        } else {
            onPlyResolved(ply, false);
        }
    }

    if (!signal?.aborted) {
        const result: DetectedOpeningResult = {
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
    async detectOpenings(params: DetectOpeningsParams): Promise<void> {
        return detectOpeningsLocalTSV(params);
    },

    clearCache(gameId?: string): void {
        if (gameId) {
            openingCache.delete(gameId);
            console.log(`[Opening] Cache cleared for gameId: ${gameId}`);
        } else {
            openingCache.clear();
            console.log(`[Opening] All cache cleared`);
        }
    },

    /** Devuelve el modo activo (siempre 'tsv'). */
    get source(): 'tsv' {
        return 'tsv';
    },
};
