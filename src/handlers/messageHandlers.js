'use strict';

const { GameStore } = require('../storage/gameStore');
const { PuzzleStore } = require('../storage/puzzleStore');
const { OpeningService } = require('../services/openings/openingService');
const { OpeningBook } = require('../services/openings/openingBook');

// [FIX] Sanitización y límites de seguridad para los parámetros del motor
function sanitizeEngineConfig(config = {}) {
    if (typeof config !== 'object' || config === null) return {};

    const maxCpus = require('os').cpus().length;
    return {
        ...config,
        threads: typeof config.threads === 'number' ? Math.max(1, Math.min(config.threads, Math.min(maxCpus, 32))) : undefined,
        hash: typeof config.hash === 'number' ? Math.max(16, Math.min(config.hash, 8192)) : undefined,
        depth: typeof config.depth === 'number' ? Math.max(1, Math.min(config.depth, 40)) : undefined,
        multiPv: typeof config.multiPv === 'number' ? Math.max(1, Math.min(config.multiPv, 5)) : undefined,
    };
}

const handlers = {
    'analyze_position': (msg, { queue, send }) => {
        const { fen, moveIndex, ...config } = msg;
        queue.analyzePosition(fen, moveIndex, sanitizeEngineConfig(config), {
            onProgress: (data) => send({ type: 'position_progress', ...data }),
            onResult: (data) => send({ type: 'position_result', ...data }),
            onError: (err) => send({ type: 'error', message: err.message }),
        });
    },

    'analyze_game': (msg, { queue, send }) => {
        const { history, currentIndex, gameId, engineConfig, startFen, playerColor, win, timeControl, playerWhite, playerBlack } = msg;
        queue.analyzeGame(history, currentIndex, gameId, sanitizeEngineConfig(engineConfig), {
            onStatus: (running) => send({ type: 'status', running }),
            onProgress: (pct, label) => send({ type: 'progress', pct, label }),
            onMoveResult: (data) => send({ type: 'move_result', ...data }),
            onOpeningDetected: (data) => send({ type: 'opening_detected', ...data, bookPlies: data.bookPlies ? Array.from(data.bookPlies) : [] }),
            onComplete: (acc) => send({ type: 'complete', accuracy: acc }),
            onCancelled: () => send({ type: 'cancelled' }),
            onError: (err) => send({ type: 'error', message: err.message }),
        }, startFen, { playerColor, win, timeControl, playerWhite, playerBlack }).catch((err) => {
            if (err.name !== 'AbortError') send({ type: 'error', message: err.message });
        });
    },

    'analyze_games': (msg, { queue, send }) => {
        const { games, engineConfig } = msg;
        if (!Array.isArray(games) || games.length === 0) return send({ type: 'error', message: 'No games provided' });

        queue.analyzeGames(games, sanitizeEngineConfig(engineConfig), {
            onGameStarted: (data) => send({ type: 'batch_analysis_started', ...data }),
            onGameProgress: (data) => send({ type: 'batch_analysis_progress', ...data }),
            onGameComplete: (data) => send({ type: 'batch_analysis_game_complete', ...data }),
            onBatchComplete: (data) => send({ type: 'batch_analysis_complete', ...data }),
            onCancelled: () => send({ type: 'batch_analysis_cancelled' }),
            onError: (err) => send({ type: 'error', message: err.message }),
            onMoveResult: (data) => send({ type: 'batch_move_result', ...data }),
        }).catch((err) => {
            if (err.name !== 'AbortError') send({ type: 'error', message: err.message });
        });
    },

    'cancel': (msg, { queue, puzzleExtractor }) => { queue.cancel(); puzzleExtractor.cancel(); },
    'clear_cache': (msg) => { OpeningService.clearCache(msg.gameId); },

    'extract_puzzles': (msg, { puzzleExtractor, send }) => {
        const { games, engineConfig } = msg;
        if (!Array.isArray(games) || games.length === 0) return send({ type: 'error', message: 'No games provided' });

        send({ type: 'puzzle_extraction_started', totalGames: games.length });
        puzzleExtractor.extractFromGames(games, sanitizeEngineConfig(engineConfig), {
            onGameDone: (data) => send({ type: 'puzzle_game_done', ...data }),
            onComplete: (data) => send({ type: 'puzzle_extraction_complete', ...data }),
            onCancelled: (data) => send({ type: 'extraction_cancelled', ...data }),
            onError: (err) => send({ type: 'error', message: err.message }),
        }).catch((err) => {
            if (err.name !== 'AbortError') send({ type: 'error', message: err.message });
        });
    },

    'cancel_extraction': (msg, { puzzleExtractor }) => { puzzleExtractor.cancel(); },
    'get_puzzles': (msg, { send }) => { send({ type: 'puzzle_list', puzzles: PuzzleStore.getAll() }); },
    'delete_puzzle': (msg, { send }) => { send({ type: 'puzzle_deleted', id: msg.id, success: PuzzleStore.delete(msg.id) }); },
    'clear_puzzles': (msg, { send }) => { PuzzleStore.clear(); send({ type: 'puzzles_cleared' }); },
    'puzzle_solved': (msg) => { PuzzleStore.incrementSolved(msg.id); },

    'get_stats': (msg, { send }) => {
        GameStore.getStats(msg.filters || {}).then(stats => {
            send({ type: 'stats_data', requestId: msg.requestId, stats: stats || { games: [], total: 0, avgAcc: 0, accuracyByPhase: [], moveQuality: [] } });
        }).catch(err => send({ type: 'error', message: err.message, requestId: msg.requestId }));
    },

    'get_stat_details': (msg, { send }) => {
        GameStore.getStatDetails(msg.category, msg.filters || {}).then(details => {
            send({ type: 'stat_details_data', requestId: msg.requestId, category: msg.category, details });
        }).catch(err => send({ type: 'error', message: err.message, requestId: msg.requestId }));
    },

    'get_analyses': (msg, { send }) => {
        const { offset = 0, limit = 50 } = msg;
        GameStore.getAll(offset, limit).then(analyses => {
            send({ type: 'analyses_list', analyses, offset, limit, total: analyses.length });
        }).catch(err => send({ type: 'error', message: err.message }));
    },

    'delete_analyses': (msg, { send }) => {
        GameStore.delete(msg.ids).then(() => send({ type: 'analyses_deleted', ids: msg.ids }))
            .catch(err => send({ type: 'error', message: err.message }));
    },

    'get_full_analysis': (msg, { send, ws }) => {
        const { gameId, requestId } = msg;
        // [FIX] Zero-Copy Bypass: Evita JSON.parse y latencia masiva en el Event Loop
        GameStore.getFullRaw(gameId).then(rawJson => {
            if (rawJson) {
                const gameIdStr = JSON.stringify(gameId);
                const reqIdStr = requestId !== undefined ? `,"requestId":${JSON.stringify(requestId)}` : '';
                const responseStr = `{"type":"full_analysis_data","gameId":${gameIdStr}${reqIdStr},"data":${rawJson}}`;
                if (ws.readyState === ws.OPEN) ws.send(responseStr);
            } else {
                send({ type: 'error', message: `Analysis not found for gameId: ${gameId}` });
            }
        }).catch(err => send({ type: 'error', message: err.message }));
    },

    'get_move_explorer': (msg, { send }) => {
        const fen = msg.fen?.trim();
        if (!fen) return send({ type: 'error', message: 'get_move_explorer: fen is required' });
        GameStore.getMoveExplorer(fen).then(data => send({ type: 'move_explorer_data', fen, ...data }))
            .catch(err => send({ type: 'error', message: err.message }));
    },

    'get_book_moves': (msg, { send }) => {
        const { fen } = msg;
        if (!fen || typeof fen !== 'string' || !OpeningBook.size) {
            return send({ type: 'book_moves', fen: fen || '', moves: [], source: 'none' });
        }
        try {
            const rawMoves = OpeningBook.getMoves(fen);
            const entry = OpeningBook.lookup(fen);
            const totalW = rawMoves.reduce((s, m) => s + m.count, 0);
            const moves = rawMoves.map(m => ({
                uci: m.uci, san: m.san, weight: m.count,
                freq: totalW > 0 ? Math.round((m.count / totalW) * 100) : 0,
            }));
            send({ type: 'book_moves', fen, moves, opening: entry?.name || 'Teoría de Aperturas', eco: entry?.eco || '', source: 'tsv' });
        } catch (e) {
            send({ type: 'book_moves', fen, moves: [], source: 'error', error: e.message });
        }
    },

    'get_server_config': (msg, { send }) => {
        send({ type: 'server_config', openingSource: OpeningService.source, bookSize: OpeningBook.size });
    },
};

function handleClientMessage(msg, context) {
    const handler = handlers[msg.type];
    if (handler) {
        // [FIX] Bloque Try/Catch global para capturar errores síncronos de forma segura
        try {
            handler(msg, context);
        } catch (error) {
            console.error(`[Handler Error] Action '${msg.type}' failed:`, error);
            context.send({ type: 'error', message: `Server error processing '${msg.type}': ${error.message}` });
        }
    } else {
        context.send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    }
}

module.exports = { handleClientMessage };