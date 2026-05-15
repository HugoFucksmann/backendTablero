'use strict';
require('dotenv').config();

const http = require('http');
const { WebSocketServer } = require('ws');

// Imports
const { AnalysisQueue } = require('./services/analysis/analysisQueue');
const { PuzzleExtractor } = require('./services/puzzles/puzzleExtractor');
const { PuzzleStore } = require('./storage/puzzleStore');
const { OpeningBook } = require('./services/openings/openingBook');
const { OpeningService } = require('./services/openings/openingService');
const { GameStore } = require('./storage/gameStore');
const { handleClientMessage } = require('./handlers/messageHandlers');

// [FIX] Listeners globales para prevenir caídas de proceso por errores no capturados
process.on('uncaughtException', (err) => {
    console.error('[Process CRITICAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Inicializar libros de aperturas al arranque
OpeningBook.load();
console.log(`[Server] Opening source: ${OpeningService.source} | TSV Book size: ${OpeningBook.size} entries`);

GameStore.runIntegrityCheck();

const PORT = parseInt(process.env.PORT || '9001', 10);

const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'chess-analysis-server', version: '1.1.0' }));
});

// [FIX] Límite de Payload (1MB) para prevenir ataques OOM (Denegación de Servicio)
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on('connection', (ws) => {
    console.log('[Server] Client connected');
    const queue = new AnalysisQueue();
    const puzzleExtractor = new PuzzleExtractor();

    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }));
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

// [FIX] Graceful Shutdown real: Cierra conexiones WS, BD y limpia recursos antes de salir
let isShuttingDown = false;
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);

    wss.clients.forEach((client) => {
        client.close(1001, 'Server shutting down');
    });

    // Asegurar que las transacciones WAL de SQLite se escriban en disco
    await GameStore.closeDatabase();

    server.close(() => {
        console.log('[Server] Closed HTTP/WS connections. Exiting process.');
        process.exit(0);
    });

    // Timeout de seguridad: Si no cierra en 5 seg, fuerza la salida
    setTimeout(() => {
        console.error('[Server] Forced exit after timeout.');
        process.exit(1);
    }, 5000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));