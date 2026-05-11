'use strict';

const { randomUUID } = require('crypto');
const { SqliteStore } = require('./sqliteStore');

const PuzzleStore = {
    getAll() {
        return SqliteStore.getPuzzles();
    },

    save(puzzle) {
        // Evitar duplicados (misma posición y misma secuencia de solución)
        const all = SqliteStore.getPuzzles();
        const isDuplicate = all.some(p => 
            p.fen === puzzle.fen && 
            JSON.stringify(p.solutionSequence) === JSON.stringify(puzzle.solutionSequence)
        );

        if (isDuplicate) return null;

        const entry = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            solvedCount: 0,
            ...puzzle,
        };
        
        SqliteStore.savePuzzle(entry);
        return entry;
    },

    delete(id) {
        return SqliteStore.deletePuzzle(id);
    },

    clear() {
        // Podríamos añadir SqliteStore.clearPuzzles() si fuera necesario
    },

    incrementSolved(id) {
        SqliteStore.incrementPuzzleSolved(id);
    },
};

module.exports = { PuzzleStore };
