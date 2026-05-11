'use strict';

const fetch = global.fetch || require('node-fetch');
const { OpeningBook }    = require('./openingBook');
const { PolyglotBook, computePolyglotHash } = require('./polyglotBook');
const { Chess }          = require('chess.js');

// ── Configuración ─────────────────────────────────────────────────────────────

const MAX_BOOK_PLY           = 30;
const MIN_THEORY_GAMES       = 230_000;
const MAX_MOVE_RANK          = 6;
const LICHESS_DELAY_MS       = 600;
const LICHESS_TIMEOUT_MS     = 10_000;
const MAX_CONSECUTIVE_NONBOOK = 2;
const RATINGS_PARAM          = '1800,2000,2200,2500';

// ── SWITCH: modo de detección de aperturas para análisis completo ─────────────
//
//  'lichess'   → comportamiento original: TSV local + Lichess Masters API
//  'polyglot'  → libro offline gm2001.bin (rápido, sin red)
//
// Cambiar este valor para comparar ambos métodos.
// El modo 'lichess' sigue usándose intacto en el panel de análisis normal.
// ─────────────────────────────────────────────────────────────────────────────
const OPENING_SOURCE = process.env.OPENING_SOURCE || 'lichess';

const openingCache = new Map();
const MAX_CACHE_SIZE = 100;

// Caché de nombres de apertura por FEN (4 partes) → { name, eco }
// Persiste durante toda la sesión del servidor. Evita llamadas HTTP
// repetidas cuando varias partidas pasan por la misma apertura.
const openingNameCache = new Map();
const MAX_NAME_CACHE_SIZE = 300;


// ── Helpers ───────────────────────────────────────────────────────────────────

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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Modo Polyglot (offline) ───────────────────────────────────────────────────

/**
 * Detecta aperturas consultando el libro Polyglot gm2001.bin.
 * Sin llamadas de red → instantáneo, determinista.
 *
 * Lógica:
 *  - Reproduce la partida jugada a jugada con chess.js.
 *  - En cada ply comprueba si el movimiento jugado está en el libro.
 *  - Un ply se marca como "book" si tiene peso > 0 en el libro.
 *  - Nombre de apertura: TSV local primero; si no está disponible (TSV vacío),
 *    hace UNA llamada a Lichess al final para obtener el nombre del último ply
 *    en teoria. Esto asegura que opening se guarda correctamente en SQLite.
 */
async function detectOpeningsPolyglot({ positions, history, gameId, signal, onPlyResolved, onOpeningDetected }) {
    if (openingCache.has(gameId)) {
        const cache = openingCache.get(gameId);
        const cachedBookPlies = cache.bookPlies instanceof Set
            ? cache.bookPlies : new Set(cache.bookPlies);
        (async () => {
            for (let i = 0; i < history.length; i++) {
                if (signal?.aborted) break;
                onPlyResolved(i, cachedBookPlies.has(i));
                if (i % 10 === 0) await new Promise(r => setImmediate(r));
            }
            if (!signal?.aborted) onOpeningDetected?.({ ...cache, bookPlies: cachedBookPlies });
        })();
        return;
    }

    console.log(`[Opening/Polyglot] Analizando con gm2001.bin | gameId=${gameId}`);

    const maxPly        = Math.min(history.length, MAX_BOOK_PLY);
    const bookPlies     = new Set();
    let finalOpeningName = '';
    let finalEcoCode     = '';
    let lastTheoryPly    = -1;
    let consecutiveNonBook = 0;

    // Instancia chess.js para reproducir la partida desde la posición inicial
    const chess = new Chess(positions[0]);

    for (let ply = 0; ply < maxPly; ply++) {
        if (signal?.aborted) break;
        if (consecutiveNonBook >= MAX_CONSECUTIVE_NONBOOK) {
            for (let i = ply; i < maxPly; i++) onPlyResolved(i, false);
            break;
        }

        const moveObj = history[ply];

        // ── Convertir la jugada a UCI ─────────────────────────────────────────
        // history[] puede contener SAN strings (ej: "d3") o verbose objects
        // con campo .lan (ej: "d2d3"). El libro Polyglot espera formato UCI.
        let playedUci = null;
        if (typeof moveObj === 'string') {
            // SAN → buscar en el tablero actual para obtener from+to
            const verboseMoves = chess.moves({ verbose: true });
            const match = verboseMoves.find(m => m.san === moveObj);
            if (match) playedUci = match.from + match.to + (match.promotion || '');
        } else if (moveObj) {
            // Objeto verbose: intentar .lan, luego from+to
            playedUci = moveObj.lan ||
                (moveObj.from && moveObj.to
                    ? moveObj.from + moveObj.to + (moveObj.promotion || '')
                    : null);
        }

        // ── Consultar el libro ────────────────────────────────────────────────
        const bookMoves = PolyglotBook.lookup(chess);
        const inBook    = playedUci ? bookMoves.some(m => m.uci === playedUci) : false;

        if (inBook) {
            bookPlies.add(ply);
            lastTheoryPly = ply;
            consecutiveNonBook = 0;
        } else {
            consecutiveNonBook++;
        }

        // ── Nombre de apertura (TSV local) ────────────────────────────────────
        const fenAfter = positions[ply + 1];
        if (fenAfter) {
            const localEntry = OpeningBook.lookup(fenAfter);
            if (localEntry) {
                finalOpeningName = localEntry.rootName || localEntry.name;
                finalEcoCode     = localEntry.eco;
            }
        }

        onPlyResolved(ply, inBook);

        // ── Avanzar el tablero ────────────────────────────────────────────────
        try {
            if (typeof moveObj === 'string') {
                chess.move(moveObj);          // SAN
            } else if (moveObj?.from && moveObj?.to) {
                chess.move({ from: moveObj.from, to: moveObj.to, promotion: moveObj.promotion });
            } else if (playedUci && playedUci.length >= 4) {
                chess.move({ from: playedUci.slice(0,2), to: playedUci.slice(2,4), promotion: playedUci[4] });
            }
        } catch {
            // Jugada inconsistente — detener el análisis de apertura
            for (let i = ply + 1; i < maxPly; i++) onPlyResolved(i, false);
            break;
        }
    }

    if (!signal?.aborted) {
        // ── Si no obtuvimos nombre del TSV, obtenerlo de Lichess (una sola llamada) ────
        // Esto garantiza que 'opening' se guarda correctamente en SQLite aunque
        // los archivos TSV no estén presentes, y los filtros del dashboard funcionen.
        if (!finalOpeningName && lastTheoryPly >= 0) {
            const lichessFen = positions[lastTheoryPly + 1] || positions[lastTheoryPly];
            if (lichessFen) {
                const fen4 = lichessFen.split(' ').slice(0, 4).join(' ');

                // Verificar caché primero (evita HTTP si ya vimos este opening)
                if (openingNameCache.has(fen4)) {
                    const cached = openingNameCache.get(fen4);
                    finalOpeningName = cached.name;
                    finalEcoCode     = cached.eco;
                    console.log(`[Opening/Polyglot] Nombre desde caché: "${finalOpeningName}"`);
                } else {
                    try {
                        const url = `https://explorer.lichess.ovh/lichess?fen=${encodeURIComponent(fen4)}&ratings=${RATINGS_PARAM}`;
                        const res = await fetchWithTimeout(url, {
                            headers: { 'User-Agent': 'ChessAnalysisLocalApp/1.0', 'Accept': 'application/json' }
                        }, 5_000);  // timeout reducido: 5s (era 10s)
                        if (res.ok) {
                            const data = await res.json();
                            if (data.opening?.name) {
                                const name = data.opening.name;
                                const idx  = name.indexOf(':');
                                finalOpeningName = idx !== -1 ? name.slice(0, idx).trim() : name;
                                finalEcoCode     = data.opening.eco || finalEcoCode;
                                console.log(`[Opening/Polyglot] Nombre de Lichess: "${finalOpeningName}" (${finalEcoCode})`);
                                // Guardar en caché
                                if (openingNameCache.size >= MAX_NAME_CACHE_SIZE) {
                                    openingNameCache.delete(openingNameCache.keys().next().value);
                                }
                                openingNameCache.set(fen4, { name: finalOpeningName, eco: finalEcoCode });
                            }
                        }
                    } catch {
                        console.warn('[Opening/Polyglot] No se pudo obtener nombre desde Lichess (timeout o red)');
                    }
                }
            }
        }

        const result = {
            openingName: finalOpeningName || 'Desconocida',
            ecoCode:     finalEcoCode,
            openingPly:  lastTheoryPly,
            bookPlies,
        };
        if (openingCache.size >= MAX_CACHE_SIZE) openingCache.delete(openingCache.keys().next().value);
        openingCache.set(gameId, result);
        onOpeningDetected?.(result);
    }
}

// ── Modo Lichess (original, sin cambios) ──────────────────────────────────────

async function detectOpeningsLichess({ positions, history, gameId, token, signal, onPlyResolved, onOpeningDetected }) {
    if (openingCache.has(gameId)) {
        console.log(`[Opening] Using cache for gameId: ${gameId}`);
        const cache = openingCache.get(gameId);
        const cachedBookPlies = cache.bookPlies instanceof Set
            ? cache.bookPlies
            : new Set(cache.bookPlies);
        (async () => {
            for (let i = 0; i < history.length; i++) {
                if (signal?.aborted) break;
                onPlyResolved(i, cachedBookPlies.has(i));
                if (i % 10 === 0) await new Promise(r => setImmediate(r));
            }
            if (!signal?.aborted) {
                onOpeningDetected?.({ ...cache, bookPlies: cachedBookPlies });
            }
        })();
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
            finalOpeningName = localEntry.rootName || localEntry.name;
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
                    const name = data.opening.name;
                    const idx = name.indexOf(':');
                    finalOpeningName = idx !== -1 ? name.slice(0, idx).trim() : name;
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
}

// ── API pública ───────────────────────────────────────────────────────────────

const OpeningService = {
    /**
     * Punto de entrada único para detección de aperturas.
     * Delega al modo configurado en OPENING_SOURCE.
     */
    async detectOpenings(params) {
        const source = OPENING_SOURCE;
        if (source === 'polyglot') {
            console.log('[Opening] Modo: Polyglot (gm2001.bin)');
            return detectOpeningsPolyglot(params);
        }
        // default: 'lichess'
        return detectOpeningsLichess(params);
    },

    clearCache(gameId) {
        if (gameId) {
            openingCache.delete(gameId);
            console.log(`[Opening] Cache cleared for gameId: ${gameId}`);
        } else {
            openingCache.clear();
            console.log(`[Opening] All cache cleared`);
        }
    },

    /** Devuelve el modo activo ('lichess' | 'polyglot'). */
    get source() { return OPENING_SOURCE; },
};

module.exports = { OpeningService, MAX_BOOK_PLY };
