const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Cambiamos la ruta para que apunte adentro de la carpeta 'data'
const dbPath = path.join(__dirname, 'data', 'database.sqlite');
const db = new Database(dbPath);

console.log("=== DIAGNÓSTICO DE BASE DE DATOS ===\n");

// 1. Tamaño del archivo en disco
const stats = fs.statSync(dbPath);
console.log(`Tamaño del archivo: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);

// 2. Obtener la lista de tablas
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';").all();

tables.forEach(({ name }) => {
    console.log(`\n---------------------------------`);
    console.log(`Tabla: ${name}`);
    console.log(`---------------------------------`);

    // Contar registros
    const count = db.prepare(`SELECT COUNT(*) as total FROM ${name}`).get().total;
    console.log(`Total de registros: ${count}`);

    // Ver esquema (columnas y tipos)
    const columns = db.prepare(`PRAGMA table_info(${name});`).all();
    console.log("\n[Columnas]:");
    columns.forEach(col => {
        console.log(`  - ${col.name} (${col.type}) ${col.notnull ? 'NOT NULL' : ''}`);
    });

    // Ver índices de la tabla
    const indexes = db.prepare(`PRAGMA index_list(${name});`).all();
    console.log("\n[Índices actuales]:");
    if (indexes.length === 0) {
        console.log("  (Ninguno) ⚠️");
    } else {
        indexes.forEach(idx => {
            console.log(`  - ${idx.name} (Único: ${idx.unique})`);
        });
    }

    // Tamaño estimado por fila si hay datos
    if (count > 0) {
        // Tomamos una muestra para calcular el peso de los textos/blobs
        const sample = db.prepare(`SELECT * FROM ${name} LIMIT 1`).get();
        let rowSize = 0;
        for (let key in sample) {
            if (sample[key]) rowSize += sample[key].toString().length;
        }
        console.log(`\n[Peso aprox. de un registro]: ${(rowSize / 1024).toFixed(2)} KB`);
    }
});

// 3. Configuración actual de rendimiento
console.log(`\n=================================`);
console.log(`PRAGMAs actuales:`);
console.log(`- Journal Mode: ${db.prepare('PRAGMA journal_mode;').get().journal_mode}`);
console.log(`- Synchronous: ${db.prepare('PRAGMA synchronous;').get().synchronous}`);

db.close();