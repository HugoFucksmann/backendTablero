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

const { GameStore } = require('./storage/gameStore');

// Inicializar el libro de aperturas al arranque
OpeningBook.load();

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
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
        };

        switch (msg.type) {
            case 'analyze_position': {
                const { fen, moveIndex, ...config } = msg;
                queue.analyzePosition(fen, moveIndex, config, {
                    onProgress: (data) => send({ type: 'position_progress', ...data }),
                    onResult: (data) => send({ type: 'position_result', ...data }),
                    onError: (err) => send({ type: 'error', message: err.message }),
                });
                break;
            }

            case 'analyze_game': {
                const { history, currentIndex, gameId, engineConfig, startFen, playerColor, win, timeControl } = msg;
                queue.analyzeGame(history, currentIndex, gameId, engineConfig, {
                    onStatus: (running) => send({ type: 'status', running }),
                    onProgress: (pct, label) => send({ type: 'progress', pct, label }),
                    onMoveResult: (data) => send({ type: 'move_result', ...data }),
                    onOpeningDetected: (data) => send({
                        type: 'opening_detected', ...data,
                        bookPlies: data.bookPlies ? Array.from(data.bookPlies) : []
                    }),
                    onComplete: (acc) => send({ type: 'complete', accuracy: acc }),
                    onCancelled: () => send({ type: 'cancelled' }),
                    onError: (err) => send({ type: 'error', message: err.message }),
                }, startFen, { playerColor, win, timeControl }).catch((err) => {
                    if (err.name !== 'AbortError') send({ type: 'error', message: err.message });
                });
                break;
            }

            case 'cancel': {
                queue.cancel();
                puzzleExtractor.cancel();
                break;
            }

            case 'clear_cache': {
                OpeningService.clearCache(msg.gameId);
                break;
            }

            case 'extract_puzzles': {
                const { games, engineConfig = {} } = msg;
                if (!Array.isArray(games) || games.length === 0) {
                    send({ type: 'error', message: 'No games provided for puzzle extraction' });
                    break;
                }
                send({ type: 'puzzle_extraction_started', totalGames: games.length });
                puzzleExtractor.extractFromGames(games, engineConfig, {
                    onGameDone: (data) => send({ type: 'puzzle_game_done', ...data }),
                    onComplete: (data) => send({ type: 'puzzle_extraction_complete', ...data }),
                    onCancelled: (data) => send({ type: 'extraction_cancelled', ...data }),
                    onError: (err) => send({ type: 'error', message: err.message }),
                }).catch((err) => {
                    if (err.name !== 'AbortError') send({ type: 'error', message: err.message });
                });
                break;
            }

            case 'cancel_extraction': {
                puzzleExtractor.cancel();
                break;
            }

            case 'get_puzzles': {
                const puzzles = PuzzleStore.getAll();
                send({ type: 'puzzle_list', puzzles });
                break;
            }

            case 'delete_puzzle': {
                const deleted = PuzzleStore.delete(msg.id);
                send({ type: 'puzzle_deleted', id: msg.id, success: deleted });
                break;
            }

            case 'clear_puzzles': {
                PuzzleStore.clear();
                send({ type: 'puzzles_cleared' });
                break;
            }

            case 'puzzle_solved': {
                PuzzleStore.incrementSolved(msg.id);
                break;
            }

            case 'get_stats': {
                GameStore.getStats().then(stats => {
                    if (!stats) {
                        send({ type: 'stats_data', stats: { games: [], summary: { totalAnalyses: 0, avgAccuracyWhite: 0, avgAccuracyBlack: 0 }, accuracyByPhase: [], moveQuality: [] } });
                    } else {
                        send({ type: 'stats_data', stats });
                    }
                }).catch(err => send({ type: 'error', message: err.message }));
                break;
            }

            case 'get_analyses': {
                GameStore.getAll().then(analyses => {
                    send({ type: 'analyses_list', analyses });
                }).catch(err => send({ type: 'error', message: err.message }));
                break;
            }

            case 'delete_analyses': {
                const { ids } = msg;
                GameStore.delete(ids).then(() => {
                    return GameStore.getAll();
                }).then(analyses => {
                    send({ type: 'analyses_list', analyses });
                }).catch(err => send({ type: 'error', message: err.message }));
                break;
            }

            case 'get_full_analysis': {
                const { gameId } = msg;
                GameStore.getFull(gameId).then(fullAnalysis => {
                    if (fullAnalysis) {
                        send({ type: 'full_analysis_data', gameId, data: fullAnalysis });
                    }
                }).catch(err => send({ type: 'error', message: err.message }));
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
