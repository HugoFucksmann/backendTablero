'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'database.sqlite');
const PUZZLES_JSON = path.join(__dirname, 'data', 'puzzles.json');

async function migrate() {
    console.log('[Migration] Iniciando migración de puzzles.json a SQLite...');
    
    if (!fs.existsSync(PUZZLES_JSON)) {
        console.log('[Migration] No existe puzzles.json. Nada que migrar.');
        return;
    }

    const db = new Database(DB_PATH);
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS puzzles (
            id TEXT PRIMARY KEY,
            createdAt TEXT,
            fen TEXT,
            solutionSequence TEXT,
            initialMove TEXT,
            theme TEXT,
            difficulty TEXT,
            solvedCount INTEGER DEFAULT 0
        );
    `);

    try {
        const content = fs.readFileSync(PUZZLES_JSON, 'utf8');
        const data = JSON.parse(content);
        const puzzles = data.puzzles || [];

        console.log(`[Migration] Encontrados ${puzzles.length} puzzles para migrar.`);

        const stmt = db.prepare(`
            INSERT OR REPLACE INTO puzzles (id, createdAt, fen, solutionSequence, initialMove, theme, difficulty, solvedCount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const p of puzzles) {
            stmt.run(
                p.id,
                p.createdAt,
                p.fen,
                JSON.stringify(p.solutionSequence),
                p.initialMove,
                p.theme,
                p.difficulty,
                p.solvedCount || 0
            );
        }

        console.log(`[Migration] ✅ Migración de puzzles finalizada.`);
        
        // Eliminar el archivo json
        fs.unlinkSync(PUZZLES_JSON);
        console.log('[Migration] puzzles.json eliminado.');

    } catch (e) {
        console.error('[Migration] Error durante la migración de puzzles:', e.message);
    } finally {
        db.close();
    }
}

migrate();
