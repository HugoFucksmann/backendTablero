'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'database.sqlite');
const FULL_DATA_DIR = path.join(__dirname, 'data', 'full_analyses');

async function migrate() {
    console.log('[Migration] Iniciando migración de JSON a SQLite...');
    
    if (!fs.existsSync(FULL_DATA_DIR)) {
        console.log('[Migration] No existe la carpeta de análisis completos. Nada que migrar.');
        return;
    }

    const db = new Database(DB_PATH);
    
    // Asegurar que la tabla existe (por si acaso no se ejecutó el arranque del server)
    db.exec(`
        CREATE TABLE IF NOT EXISTS analysis_full_data (
            game_id TEXT PRIMARY KEY,
            full_json TEXT,
            FOREIGN KEY(game_id) REFERENCES analyses(gameId) ON DELETE CASCADE
        );
    `);

    const files = fs.readdirSync(FULL_DATA_DIR).filter(f => f.endsWith('.json'));
    console.log(`[Migration] Encontrados ${files.length} archivos para migrar.`);

    let successCount = 0;
    let failCount = 0;

    const stmt = db.prepare('INSERT OR REPLACE INTO analysis_full_data (game_id, full_json) VALUES (?, ?)');

    for (const file of files) {
        const gameId = file.replace('.json', '');
        const filePath = path.join(FULL_DATA_DIR, file);

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);

            stmt.run(gameId, JSON.stringify(data));

            successCount++;
            // Eliminar archivo tras migración exitosa
            fs.unlinkSync(filePath);
        } catch (e) {
            console.error(`[Migration] Error migrando ${file}:`, e.message);
            failCount++;
        }
    }

    db.close();
    console.log(`[Migration] ✅ Migración finalizada: ${successCount} exitosos, ${failCount} fallidos.`);
    
    try {
        if (fs.readdirSync(FULL_DATA_DIR).length === 0) {
            fs.rmdirSync(FULL_DATA_DIR);
            console.log('[Migration] Carpeta vacía eliminada.');
        }
    } catch (e) {}
}

migrate().catch(err => {
    console.error('[Migration] ❌ Error fatal:', err);
});
