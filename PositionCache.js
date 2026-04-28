const fs = require('fs');
const path = require('path');

const POSITION_CACHE_SIZE = 5000;
const OPENING_CACHE_SIZE = 100;
const CACHE_FILE = path.join(__dirname, 'cache.json');

class PositionCache {
    constructor() {
        this._positions = new Map();
        this._openings = new Map();
        this._saveTimer = null;
        this._loadFromDisk();

        // Final save on shutdown
        process.on('exit', () => {
            if (this._saveTimer) {
                clearTimeout(this._saveTimer);
                this._saveToDiskImmediate();
            }
        });
    }

    _loadFromDisk() {
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                if (data.positions) this._positions = new Map(Object.entries(data.positions));

                // RECONSTRUIMOS EL SET AL CARGAR
                if (data.openings) {
                    const parsedOpenings = new Map();
                    for (const [key, val] of Object.entries(data.openings)) {
                        parsedOpenings.set(key, {
                            ...val,
                            bookPlies: new Set(val.bookPlies || [])
                        });
                    }
                    this._openings = parsedOpenings;
                }
                console.log(`[Cache] Loaded ${this._positions.size} positions and ${this._openings.size} openings from disk`);
            }
        } catch (e) {
            console.warn('[Cache] Could not load cache from disk:', e.message);
        }
    }

    _saveToDisk() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._saveToDiskImmediate();
            this._saveTimer = null;
        }, 2000); // Wait 2s of idle before saving
    }

    _saveToDiskImmediate() {
        try {
            // CONVERTIMOS EL SET A ARRAY PARA GUARDAR EN EL JSON
            const openingsToSave = {};
            for (const [key, val] of this._openings.entries()) {
                openingsToSave[key] = {
                    ...val,
                    bookPlies: Array.from(val.bookPlies)
                };
            }

            const data = {
                positions: Object.fromEntries(this._positions),
                openings: openingsToSave,
            };
            fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
            console.log('[Cache] Persisted to disk');
        } catch (e) {
            console.error('[Cache] Error saving to disk:', e.message);
        }
    }

    // ── Position cache ───────────────────────────────────────────────────────

    positionKey(fen, depth, multiPv) {
        return `${fen}|d${depth}|mpv${multiPv}`;
    }

    getPosition(fen, depth, multiPv) {
        return this._positions.get(this.positionKey(fen, depth, multiPv)) ?? null;
    }

    setPosition(fen, depth, multiPv, result) {
        const key = this.positionKey(fen, depth, multiPv);
        if (this._positions.size >= POSITION_CACHE_SIZE) {
            this._positions.delete(this._positions.keys().next().value);
        }
        this._positions.set(key, result);
        this._saveToDisk(); // Save on update (could be debounced for higher perf)
    }

    // ── Opening cache ────────────────────────────────────────────────────────

    getOpening(gameId) {
        return this._openings.get(gameId) ?? null;
    }

    setOpening(gameId, data) {
        if (this._openings.size >= OPENING_CACHE_SIZE) {
            this._openings.delete(this._openings.keys().next().value);
        }
        this._openings.set(gameId, data);
        this._saveToDisk();
    }

    clearGame(gameId) {
        if (gameId) {
            this._openings.delete(gameId);
            this._saveToDisk();
        }
    }

    clearAll() {
        this._positions.clear();
        this._openings.clear();
        if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    }
}

module.exports = { PositionCache };