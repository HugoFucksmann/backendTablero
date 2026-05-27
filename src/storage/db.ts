import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Connection ───────────────────────────────────────────────────────────────

const DB_PATH = join(__dirname, '..', '..', 'data', 'database.sqlite');
const DATA_DIR = dirname(DB_PATH);

if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// ESTO CAMBIA TODO EL RENDIMIENTO EN DISCO:
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -64000'); // 64MB cache

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
        id               TEXT PRIMARY KEY,
        gameId           TEXT UNIQUE,
        username         TEXT,
        createdAt        TEXT,
        date             TEXT,
        opening          TEXT,
        eco              TEXT,
        moveCount        INTEGER,
        color            TEXT,
        win              INTEGER,
        timeControl      TEXT,
        whiteAccuracy    INTEGER,
        blackAccuracy    INTEGER,
        accuracyByPhase  TEXT,
        labelCounts      TEXT,
        advancedMetrics  TEXT
    );

    CREATE TABLE IF NOT EXISTS phase_accuracy (
        game_id   TEXT,
        phase     TEXT,
        accuracy  INTEGER,
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS move_quality (
        game_id  TEXT,
        label    TEXT,
        count    INTEGER,
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS game_moves (
        game_id        TEXT,
        ply            INTEGER,
        move_san       TEXT,
        evaluation     REAL,
        label          TEXT,
        move_time      INTEGER,
        remaining_time INTEGER,
        fen            TEXT,
        start_fen      TEXT,
        error_time_class TEXT,
        PRIMARY KEY (game_id, ply),
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS analysis_full_data (
        game_id   TEXT PRIMARY KEY,
        full_json TEXT,
        FOREIGN KEY(game_id) REFERENCES analyses(gameId) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS puzzles (
        id                  TEXT PRIMARY KEY,
        createdAt           TEXT,
        fen                 TEXT,
        solutionSequence    TEXT,
        -- Legacy columns (kept for backwards compatibility)
        initialMove         TEXT,
        theme               TEXT,
        difficulty          TEXT,
        solvedCount         INTEGER DEFAULT 0,
        -- Puzzle identity
        baseFen             TEXT,
        contextMoves        TEXT,
        originalContinuation TEXT,
        preBlunderFen       TEXT,
        playedMove          TEXT,
        label               TEXT,
        puzzleType          TEXT,
        mateIn              INTEGER,
        -- Metrics
        wpLoss              REAL,
        preBlunderWp        REAL,
        playerColor         TEXT,
        gameId              TEXT,
        ply                 INTEGER,
        -- Enriched / mined data
        blunderSeverity     REAL,
        tensionIndex        REAL,
        attackedSquares     INTEGER,
        isOnlyMove          INTEGER,    -- stored as 0/1 (SQLite has no BOOLEAN)
        criticalityGap      REAL,
        tacticalMotifs      TEXT        -- JSON array
    );

    CREATE INDEX IF NOT EXISTS idx_date          ON analyses(date);
    CREATE INDEX IF NOT EXISTS idx_timeControl   ON analyses(timeControl);
    CREATE INDEX IF NOT EXISTS idx_phase_game    ON phase_accuracy(game_id);
    CREATE INDEX IF NOT EXISTS idx_quality_game  ON move_quality(game_id);
    CREATE INDEX IF NOT EXISTS idx_moves_game    ON game_moves(game_id);
    CREATE INDEX IF NOT EXISTS idx_moves_label   ON game_moves(label);
    CREATE INDEX IF NOT EXISTS idx_moves_fen      ON game_moves(fen);
    CREATE INDEX IF NOT EXISTS idx_moves_start_fen ON game_moves(start_fen);
`);

// ─── Migrations (incremental, safe to re-run) ─────────────────────────────────

const migrations = [
    // analyses table
    "ALTER TABLE analyses ADD COLUMN eco TEXT",
    "ALTER TABLE analyses ADD COLUMN username TEXT",
    "ALTER TABLE analyses ADD COLUMN advancedMetrics TEXT",
    "CREATE INDEX IF NOT EXISTS idx_username ON analyses(username)",
    "ALTER TABLE analyses ADD COLUMN opponent TEXT",
    "ALTER TABLE analyses ADD COLUMN gameDate TEXT",
    "CREATE INDEX IF NOT EXISTS idx_gameDate ON analyses(gameDate)",

    // game_moves table
    "ALTER TABLE game_moves ADD COLUMN error_time_class TEXT",

    // puzzles table — all new columns added after the original 8-column schema
    "ALTER TABLE puzzles ADD COLUMN baseFen TEXT",
    "ALTER TABLE puzzles ADD COLUMN contextMoves TEXT",
    "ALTER TABLE puzzles ADD COLUMN originalContinuation TEXT",
    "ALTER TABLE puzzles ADD COLUMN preBlunderFen TEXT",
    "ALTER TABLE puzzles ADD COLUMN playedMove TEXT",
    "ALTER TABLE puzzles ADD COLUMN label TEXT",
    "ALTER TABLE puzzles ADD COLUMN puzzleType TEXT",
    "ALTER TABLE puzzles ADD COLUMN mateIn INTEGER",
    "ALTER TABLE puzzles ADD COLUMN wpLoss REAL",
    "ALTER TABLE puzzles ADD COLUMN preBlunderWp REAL",
    "ALTER TABLE puzzles ADD COLUMN playerColor TEXT",
    "ALTER TABLE puzzles ADD COLUMN gameId TEXT",
    "ALTER TABLE puzzles ADD COLUMN ply INTEGER",
    "ALTER TABLE puzzles ADD COLUMN blunderSeverity REAL",
    "ALTER TABLE puzzles ADD COLUMN tensionIndex REAL",
    "ALTER TABLE puzzles ADD COLUMN attackedSquares INTEGER",
    "ALTER TABLE puzzles ADD COLUMN isOnlyMove INTEGER",
    "ALTER TABLE puzzles ADD COLUMN criticalityGap REAL",
    "ALTER TABLE puzzles ADD COLUMN tacticalMotifs TEXT",
    // puzzles indexes
    "CREATE INDEX IF NOT EXISTS idx_puzzles_fen ON puzzles(fen)",
    "CREATE INDEX IF NOT EXISTS idx_puzzles_gameId ON puzzles(gameId)",
    "CREATE INDEX IF NOT EXISTS idx_puzzles_type ON puzzles(puzzleType)",
];

for (const sql of migrations) {
    try {
        db.exec(sql);
    } catch (_) {
        /* column/index already exists — safe to ignore */
    }
}

// ─── Self-Healing Data Migration ──────────────────────────────────────────────

try {
    const nullRows = db.prepare(`
        SELECT id, gameId, color 
        FROM analyses 
        WHERE opponent IS NULL OR gameDate IS NULL
    `).all() as { id: string; gameId: string; color: string }[];

    if (nullRows.length > 0) {
        console.log(`[Database] Starting self-healing migration for ${nullRows.length} records...`);
        const updateStmt = db.prepare(`UPDATE analyses SET opponent = ?, gameDate = ? WHERE id = ?`);
        const getFullJson = db.prepare(`SELECT full_json FROM analysis_full_data WHERE game_id = ?`);
        
        const transaction = db.transaction((rows: typeof nullRows) => {
            for (const row of rows) {
                let opponent = 'Desconocido';
                let gameDate = null;
                const fullRow = getFullJson.get(row.gameId) as { full_json: string } | undefined;
                if (fullRow?.full_json) {
                    try {
                        const gameData = JSON.parse(fullRow.full_json);
                        if (gameData.players) {
                            opponent = row.color === 'white' ? gameData.players.black : gameData.players.white;
                        } else if (gameData.gameHeaders) {
                            opponent = row.color === 'white' ? gameData.gameHeaders.Black : gameData.gameHeaders.White;
                        }
                        gameDate = gameData.gameHeaders?.UTCDate || gameData.gameHeaders?.Date || null;
                    } catch (e) {
                        console.error(`[Database] Failed to parse full_json for self-healing, gameId: ${row.gameId}`, e);
                    }
                }
                updateStmt.run(opponent, gameDate, row.id);
            }
        });
        
        transaction(nullRows);
        console.log(`[Database] ✅ Self-healing migration completed successfully.`);
    }
} catch (err: any) {
    console.error('[Database] ❌ Self-healing migration failed:', err.message);
}

// ─── Database Maintenance & Optimization ──────────────────────────────────────

try {
    console.log('[Database] Running vacuum and optimization...');
    db.pragma('vacuum');
    db.pragma('optimize');
    console.log('[Database] ✅ Database vacuum and optimization completed.');
} catch (err: any) {
    console.error('[Database] Maintenance error:', err.message);
}

export default db;
export type DatabaseInstance = typeof db;

