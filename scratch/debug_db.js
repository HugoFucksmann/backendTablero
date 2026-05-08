const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '../data/analysis.db');
const db = new Database(dbPath);

console.log('--- Analyses Table ---');
const analyses = db.prepare('SELECT id, color, whiteAccuracy, blackAccuracy, opening, win FROM analyses LIMIT 5').all();
console.log(JSON.stringify(analyses, null, 2));

console.log('\n--- Move Quality Count ---');
const quality = db.prepare('SELECT label, SUM(count) as total FROM move_quality GROUP BY label').all();
console.log(JSON.stringify(quality, null, 2));

console.log('\n--- Game Moves Count ---');
const moves = db.prepare('SELECT label, COUNT(*) as count FROM game_moves GROUP BY label').all();
console.log(JSON.stringify(moves, null, 2));
