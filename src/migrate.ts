import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = join(__dirname, '..', 'data', 'database.sqlite');
const db = new Database(DB_PATH);

console.log('[Migration] Iniciando migración de datos normalizados...');

// Asegurar que el esquema existe
db.exec(`
    CREATE TABLE IF NOT EXISTS phase_accuracy (
        game_id TEXT,
        phase TEXT,
        accuracy INTEGER,
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS move_quality (
        game_id TEXT,
        label TEXT,
        count INTEGER,
        FOREIGN KEY(game_id) REFERENCES analyses(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_phase_game ON phase_accuracy(game_id);
    CREATE INDEX IF NOT EXISTS idx_quality_game ON move_quality(game_id);
`);

try {
    const analyses = db.prepare('SELECT id, accuracyByPhase, labelCounts FROM analyses').all() as any[];
    console.log(`[Migration] Encontradas ${analyses.length} partidas para procesar.`);

    const insertPhase = db.prepare('INSERT INTO phase_accuracy (game_id, phase, accuracy) VALUES (?, ?, ?)');
    const insertQuality = db.prepare('INSERT INTO move_quality (game_id, label, count) VALUES (?, ?, ?)');
    const deletePhases = db.prepare('DELETE FROM phase_accuracy');
    const deleteQuality = db.prepare('DELETE FROM move_quality');

    const transaction = db.transaction((rows: any[]) => {
        deletePhases.run();
        deleteQuality.run();

        for (const row of rows) {
            let phases: any[] = [];
            let qualities: Record<string, number> = {};

            try {
                phases = JSON.parse(row.accuracyByPhase || '[]');
            } catch (e) {
                console.warn(`[Migration] Error parseando fases para ${row.id}`);
            }

            try {
                qualities = JSON.parse(row.labelCounts || '{}');
            } catch (e) {
                console.warn(`[Migration] Error parseando calidad para ${row.id}`);
            }

            if (Array.isArray(phases)) {
                for (const { phase, accuracy } of phases) {
                    insertPhase.run(row.id, phase, accuracy);
                }
            }

            if (qualities && typeof qualities === 'object') {
                for (const [label, count] of Object.entries(qualities)) {
                    insertQuality.run(row.id, label, count);
                }
            }
        }
    });

    transaction(analyses);
    console.log('[Migration] ✅ Migración completada con éxito.');
} catch (error: any) {
    console.error('[Migration] ❌ Error durante la migración:', error.message);
} finally {
    db.close();
}
