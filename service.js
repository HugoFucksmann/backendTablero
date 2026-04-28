/**
 * Chess Analysis Server - Local WebSocket Backend
 * Replaces the browser WASM Stockfish with a native binary for maximum performance.
 *
 * Usage:
 *   STOCKFISH_PATH=/path/to/stockfish node server.js
 *   Options via env:
 *     PORT            - WebSocket port (default: 9001)
 *     STOCKFISH_PATH  - Path to Stockfish binary (default: ./stockfish)
 */

'use strict';
require('dotenv').config();

const http = require('http');
const { WebSocketServer } = require('ws');
const { AnalysisQueue } = require('./Analysisqueue.js');
const { PositionCache } = require('./PositionCache.js');

const PORT = parseInt(process.env.PORT || '9001', 10);

// Shared cache across all connections
const positionCache = new PositionCache();

// One AnalysisQueue per client connection (each gets its own Stockfish process)
const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'chess-analysis-server', version: '1.0.0' }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('[Server] Client connected');
    const queue = new AnalysisQueue(positionCache);

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
            // ── Single position (live analysis while navigating moves) ──────────
            case 'analyze_position': {
                const { fen, moveIndex, depth, multiPv } = msg;
                queue.analyzePosition(fen, moveIndex, { depth, multiPv }, {
                    onProgress: (data) => send({ type: 'position_progress', ...data }),
                    onResult: (data) => send({ type: 'position_result', ...data }),
                    onError: (err) => send({ type: 'error', message: err.message }),
                });
                break;
            }

            // ── Full game (post-game deep analysis) ─────────────────────────────
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

            // ── Cancel any running analysis ─────────────────────────────────────
            case 'cancel': {
                queue.cancel();
                send({ type: 'cancelled' });
                break;
            }

            // ── Cache management ────────────────────────────────────────────────
            case 'clear_cache': {
                const { gameId } = msg;
                positionCache.clearGame(gameId);
                send({ type: 'cache_cleared', gameId });
                break;
            }

            default:
                send({ type: 'error', message: `Unknown message type: ${msg.type}` });
        }
    });

    ws.on('close', () => {
        console.log('[Server] Client disconnected — cleaning up');
        queue.cancel();
        queue.destroy();
    });

    ws.on('error', (err) => {
        console.error('[Server] WebSocket error:', err.message);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Server] Chess analysis server listening on ws://127.0.0.1:${PORT}`);
    console.log(`[Server] Stockfish binary: ${process.env.STOCKFISH_PATH || 'stockfish'}`);
});

process.on('SIGINT', () => { console.log('\n[Server] Shutting down...'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });