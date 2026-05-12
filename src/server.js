'use strict';
require('dotenv').config();

const http = require('http');
const { WebSocketServer } = require('ws');

// Imports refactorizados
const { AnalysisQueue } = require('./services/analysis/analysisQueue');
const { PuzzleExtractor } = require('./services/puzzles/puzzleExtractor');
const { PuzzleStore } = require('./storage/puzzleStore');
const { OpeningBook } = require('./services/openings/openingBook');
const { OpeningService } = require('./services/openings/openingService');
const { PolyglotBook } = require('./services/openings/polyglotBook');

const { GameStore } = require('./storage/gameStore');
const { handleClientMessage } = require('./handlers/messageHandlers');

// Inicializar libros de aperturas al arranque
OpeningBook.load();

// El libro Polyglot ha sido desactivado a favor de la búsqueda puramente en TSVs locales.
// const GM_BOOK_PATH = require('path').join(__dirname, '..', 'data', 'gm2001.bin');
// PolyglotBook.load(GM_BOOK_PATH);
console.log(`[Server] Opening source: ${OpeningService.source} | TSV Book size: ${OpeningBook.size} entries`);

GameStore.runIntegrityCheck();

const PORT = parseInt(process.env.PORT || '9001', 10);

const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'chess-analysis-server', version: '1.1.0' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('[Server] Client connected');
    const queue = new AnalysisQueue();
    const puzzleExtractor = new PuzzleExtractor();

    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        const send = (payload) => {
            if (ws.readyState === ws.OPEN) {
                const response = { ...payload };
                if (msg.requestId) response.requestId = msg.requestId;
                ws.send(JSON.stringify(response));
            }
        };

        const context = { ws, queue, puzzleExtractor, send };
        handleClientMessage(msg, context);
    });

    ws.on('close', () => {
        console.log('[Server] Client disconnected');
        queue.cancel();
        queue.destroy();
        puzzleExtractor.cancel();
        puzzleExtractor.destroy();
    });

    ws.on('error', (err) => {
        console.error('[Server] WebSocket error:', err.message);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Server] Chess analysis server listening on ws://127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => { console.log('\n[Server] Shutting down...'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
