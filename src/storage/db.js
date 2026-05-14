'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ─── Connection ───────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'database.sqlite');
const DATA_DIR = path.dirname(DB_PATH);

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

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
        PRIMARY KEY (game_id, ply),
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS analysis_full_data (
        game_id   TEXT PRIMARY KEY,
        full_json TEXT,
        FOREIGN KEY(game_id) REFERENCES analyses(gameId) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS puzzles (
        id               TEXT PRIMARY KEY,
        createdAt        TEXT,
        fen              TEXT,
        solutionSequence TEXT,
        initialMove      TEXT,
        theme            TEXT,
        difficulty       TEXT,
        solvedCount      INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_date          ON analyses(date);
    CREATE INDEX IF NOT EXISTS idx_timeControl   ON analyses(timeControl);
    CREATE INDEX IF NOT EXISTS idx_username      ON analyses(username);
    CREATE INDEX IF NOT EXISTS idx_phase_game    ON phase_accuracy(game_id);
    CREATE INDEX IF NOT EXISTS idx_quality_game  ON move_quality(game_id);
    CREATE INDEX IF NOT EXISTS idx_moves_game    ON game_moves(game_id);
    CREATE INDEX IF NOT EXISTS idx_moves_label   ON game_moves(label);
    CREATE INDEX IF NOT EXISTS idx_moves_fen     ON game_moves(fen);
`);

// ─── Migrations (incremental, safe to re-run) ─────────────────────────────────

const migrations = [
    "ALTER TABLE analyses ADD COLUMN eco TEXT",
    "ALTER TABLE analyses ADD COLUMN username TEXT",
    "ALTER TABLE analyses ADD COLUMN advancedMetrics TEXT",
    "CREATE INDEX IF NOT EXISTS idx_username ON analyses(username)",
];

for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* column/index already exists — safe to ignore */ }
}

module.exports = db;