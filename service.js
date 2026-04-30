'use strict';
require('dotenv').config();

const http = require('http');
const { WebSocketServer } = require('ws');
const { AnalysisQueue } = require('./Analysisqueue.js');

const PORT = parseInt(process.env.PORT || '9001', 10);

const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'chess-analysis-server', version: '1.0.0' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('[Server] Client connected');
    const queue = new AnalysisQueue();

    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        const send = (payload) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
        };

        switch (msg.type) {
            case 'analyze_position': {
                const { fen, moveIndex, type: _type, ...config } = msg;
                queue.analyzePosition(fen, moveIndex, config, {
                    onProgress: (data) => send({ type: 'position_progress', ...data }),
                    onResult: (data) => send({ type: 'position_result', ...data }),
                    onError: (err) => send({ type: 'error', message: err.message }),
                });
                break;
            }

            case 'analyze_game': {
                const { history, currentIndex, gameId, engineConfig } = msg;
                queue.analyzeGame(history, currentIndex, gameId, engineConfig, {
                    onStatus: (running) => send({ type: 'status', running }),
                    onProgress: (pct, label) => send({ type: 'progress', pct, label }),
                    onMoveResult: (data) => send({ type: 'move_result', ...data }),
                    onOpeningDetected: (data) => send({
                        type: 'opening_detected', ...data,
                        bookPlies: data.bookPlies ? Array.from(data.bookPlies) : []
                    }),
                    onComplete: (acc) => send({ type: 'complete', accuracy: acc }),
                    onError: (err) => send({ type: 'error', message: err.message }),
                });
                break;
            }

            case 'cancel': {
                queue.cancel();
                send({ type: 'cancelled' });
                break;
            }

            default:
                send({ type: 'error', message: `Unknown message type: ${msg.type}` });
        }
    });

    ws.on('close', () => {
        console.log('[Server] Client disconnected');
        queue.cancel();
        queue.destroy();
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