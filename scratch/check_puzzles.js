'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'database.sqlite');
console.log('Connecting to database:', DB_PATH);

try {
    const db = new Database(DB_PATH);
    const row = db.prepare('SELECT game_id, full_json FROM analysis_full_data LIMIT 1').get();
    if (row) {
        console.log('Game ID:', row.game_id);
        const parsed = JSON.parse(row.full_json);
        console.log('players:', parsed.players);
    }
    db.close();
} catch (error) {
    console.error('Error querying database:', error);
}
