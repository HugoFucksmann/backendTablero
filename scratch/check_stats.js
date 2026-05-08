const Database = require('better-sqlite3');
const path = require('path');
const dbPath = '/home/hugo/Escritorio/react/backendTablero/src/data/database.sqlite';
const db = new Database(dbPath);

console.log('--- Database Summary ---');
const total = db.prepare('SELECT COUNT(*) as count FROM analyses').get();
console.log('Total analyses:', total.count);

const usernames = db.prepare('SELECT username, COUNT(*) as count FROM analyses GROUP BY username').all();
console.log('Usernames distribution:', usernames);

const samples = db.prepare('SELECT id, username, color, whiteAccuracy, blackAccuracy, opening FROM analyses LIMIT 5').all();
console.log('Sample rows:', JSON.stringify(samples, null, 2));

const general = db.prepare(`
    SELECT 
        COUNT(*) as total,
        AVG(CASE 
            WHEN color = 'white' AND whiteAccuracy IS NOT NULL THEN whiteAccuracy
            WHEN color = 'black' AND blackAccuracy IS NOT NULL THEN blackAccuracy
            ELSE COALESCE(whiteAccuracy, blackAccuracy, 0)
        END) as avgAcc
    FROM analyses
`).get();
console.log('Global Average Accuracy (No filters):', general);
