import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Imports refactorizados
import { AnalysisQueue } from './services/analysis/analysisQueue.js';
import { PuzzleExtractor } from './services/puzzles/puzzleExtractor.js';
import { OpeningBook } from './services/openings/openingBook.js';
import { OpeningService } from './services/openings/openingService.js';
import { GameStore } from './storage/gameStore.js';
import { handleClientMessage, ClientMessageContext } from './handlers/messageHandlers.js';

// Inicializar libros de aperturas al arranque
OpeningBook.load();

console.log(`[Server] Opening source: ${OpeningService.source} | TSV Book size: ${OpeningBook.size} entries`);

GameStore.runIntegrityCheck();

const PORT = parseInt(process.env.PORT || '9001', 10);

const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'chess-analysis-server', version: '1.1.0' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
    console.log('[Server] Client connected');
    const queue = new AnalysisQueue();
    const puzzleExtractor = new PuzzleExtractor();

    ws.on('message', async (raw) => {
        let msg: any;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        const send = (payload: any) => {
            if (ws.readyState === WebSocket.OPEN) {
                const response = { ...payload };
                if (msg.requestId) {
                    response.requestId = msg.requestId;
                }
                ws.send(JSON.stringify(response));
            }
        };

        const context: ClientMessageContext = { ws, queue, puzzleExtractor, send };
        handleClientMessage(msg, context);
    });

    ws.on('close', () => {
        console.log('[Server] Client disconnected');
        queue.cancel();
        queue.destroy();
        puzzleExtractor.cancel();
        puzzleExtractor.destroy();
    });

    ws.on('error', (err: any) => {
        console.error('[Server] WebSocket error:', err.message);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Server] Chess analysis server listening on ws://127.0.0.1:${PORT}`);
});

process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
});
