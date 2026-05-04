'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, 'puzzles.json');

function _load() {
    if (!fs.existsSync(STORE_PATH)) return { puzzles: [] };
    try {
        return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch {
        return { puzzles: [] };
    }
}

function _save(data) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

const PuzzleStore = {
    getAll() {
        return _load().puzzles;
    },

    save(puzzle) {
        const data = _load();
        
        // Evitar duplicados (misma posición y misma secuencia de solución)
        const isDuplicate = data.puzzles.some(p => 
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
        data.puzzles.push(entry);
        _save(data);
        return entry;
    },

    delete(id) {
        const data = _load();
        const before = data.puzzles.length;
        data.puzzles = data.puzzles.filter(p => p.id !== id);
        _save(data);
        return data.puzzles.length < before;
    },

    clear() {
        _save({ puzzles: [] });
    },

    incrementSolved(id) {
        const data = _load();
        const puzzle = data.puzzles.find(p => p.id === id);
        if (puzzle) {
            puzzle.solvedCount = (puzzle.solvedCount ?? 0) + 1;
            _save(data);
        }
    },
};

module.exports = { PuzzleStore };
