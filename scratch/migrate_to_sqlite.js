'use strict';

const fs = require('fs');
const path = require('path');
const { SqliteStore } = require('../src/storage/sqliteStore');

const STORE_PATH = path.join(__dirname, '..', 'data', 'analyses.json');

async function migrate() {
    if (!fs.existsSync(STORE_PATH)) {
        console.log('No analyses.json found, skipping migration.');
        return;
    }

    try {
        const content = fs.readFileSync(STORE_PATH, 'utf8');
        const { analyses } = JSON.parse(content);
        
        console.log(`Migrating ${analyses.length} analyses to SQLite...`);
        
        let count = 0;
        for (const entry of analyses) {
            SqliteStore.save(entry);
            count++;
        }
        
        console.log(`Success! Migrated ${count} entries.`);
    } catch (err) {
        console.error('Migration failed:', err);
    }
}

migrate();
