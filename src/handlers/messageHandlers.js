const { GameStore } = require('../storage/gameStore');
const { PuzzleStore } = require('../storage/puzzleStore');
const { OpeningService } = require('../services/openings/openingService');
const { OpeningBook } = require('../services/openings/openingBook');
const { Chess } = require('chess.js');

const handlers = {
    'analyze_position': (msg, { queue, send }) => {
        const { fen, moveIndex, ...config } = msg;
        queue.analyzePosition(fen, moveIndex, config, {
            onProgress: (data) => send({ type: 'position_progress', ...data }),
            onResult: (data) => send({ type: 'position_result', ...data }),
            onError: (err) => send({ type: 'error', message: err.message }),
        });
    },

    'analyze_game': (msg, { queue, send }) => {
        const { history, currentIndex, gameId, engineConfig, startFen, playerColor, win, timeControl, playerWhite, playerBlack } = msg;
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
        }, startFen, { playerColor, win, timeControl, playerWhite, playerBlack }).catch((err) => {
            if (err.name !== 'AbortError') send({ type: 'error', message: err.message });
        });
    },

    'analyze_games': (msg, { queue, send }) => {
        const { games, engineConfig = {} } = msg;
        if (!Array.isArray(games) || games.length === 0) {
            send({ type: 'error', message: 'No games provided for analysis' });
            return;
        }
        queue.analyzeGames(games, engineConfig, {
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

    'cancel': (msg, { queue, puzzleExtractor }) => {
        queue.cancel();
        puzzleExtractor.cancel();
    },

    'clear_cache': (msg) => {
        OpeningService.clearCache(msg.gameId);
    },

    'extract_puzzles': (msg, { puzzleExtractor, send }) => {
        const { games, engineConfig = {} } = msg;
        if (!Array.isArray(games) || games.length === 0) {
            send({ type: 'error', message: 'No games provided for puzzle extraction' });
            return;
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
    },

    'cancel_extraction': (msg, { puzzleExtractor }) => {
        puzzleExtractor.cancel();
    },

    'get_puzzles': (msg, { send }) => {
        const puzzles = PuzzleStore.getAll();
        send({ type: 'puzzle_list', puzzles });
    },

    'delete_puzzle': (msg, { send }) => {
        const deleted = PuzzleStore.delete(msg.id);
        send({ type: 'puzzle_deleted', id: msg.id, success: deleted });
    },

    'clear_puzzles': (msg, { send }) => {
        PuzzleStore.clear();
        send({ type: 'puzzles_cleared' });
    },

    'puzzle_solved': (msg) => {
        PuzzleStore.incrementSolved(msg.id);
    },

    'get_stats': (msg, { send }) => {
        const { filters = {}, requestId } = msg;
        GameStore.getStats(filters).then(stats => {
            if (!stats) {
                send({ type: 'stats_data', requestId, stats: { games: [], total: 0, avgAcc: 0, accuracyByPhase: [], moveQuality: [] } });
            } else {
                send({ type: 'stats_data', requestId, stats });
            }
        }).catch(err => send({ type: 'error', message: err.message, requestId }));
    },

    'get_stat_details': (msg, { send }) => {
        const { category, filters = {}, requestId } = msg;
        GameStore.getStatDetails(category, filters).then(details => {
            send({ type: 'stat_details_data', requestId, category, details });
        }).catch(err => send({ type: 'error', message: err.message, requestId }));
    },

    'get_analyses': (msg, { send }) => {
        const { offset = 0, limit = 50 } = msg;
        GameStore.getAll(offset, limit).then(analyses => {
            send({ type: 'analyses_list', analyses, offset, limit, total: analyses.length });
        }).catch(err => send({ type: 'error', message: err.message }));
    },

    'delete_analyses': (msg, { send }) => {
        const { ids } = msg;
        GameStore.delete(ids).then(() => {
            send({ type: 'analyses_deleted', ids });
        }).catch(err => send({ type: 'error', message: err.message }));
    },

    'get_full_analysis': (msg, { send }) => {
        const { gameId } = msg;
        GameStore.getFull(gameId).then(fullAnalysis => {
            if (fullAnalysis) {
                send({ type: 'full_analysis_data', gameId, data: fullAnalysis });
            }
        }).catch(err => send({ type: 'error', message: err.message }));
    },

    // BUG #7 CORREGIDO: se valida que fen exista y no esté vacío antes de
    // pasarlo a GameStore. Sin esta guarda, GameStore.getMoveExplorer(undefined)
    // podría lanzar un error no controlado o devolver datos incorrectos.
    'get_move_explorer': (msg, { send }) => {
        const { fen } = msg;

        if (!fen || typeof fen !== 'string' || fen.trim() === '') {
            send({ type: 'error', message: 'get_move_explorer: fen is required' });
            return;
        }

        GameStore.getMoveExplorer(fen.trim())
            .then(data => send({ type: 'move_explorer_data', fen: fen.trim(), ...data }))
            .catch(err => send({ type: 'error', message: err.message }));
    },
    // ── Libro Polyglot ────────────────────────────────────────────────

    /**
     * Devuelve los movimientos del libro Polyglot para una posición FEN.
     * Respuesta: { type: 'book_moves', fen, moves: [{uci, san, weight, freq}], source }
     */
    'get_book_moves': (msg, { send }) => {
        const { fen } = msg;
        if (!fen || typeof fen !== 'string') {
            send({ type: 'book_moves', fen: '', moves: [], source: 'none' });
            return;
        }

        if (!OpeningBook.size) {
            send({ type: 'book_moves', fen, moves: [], source: 'none' });
            return;
        }

        try {
            const rawMoves = OpeningBook.getMoves(fen);
            const entry = OpeningBook.lookup(fen);
            const totalW = rawMoves.reduce((s, m) => s + m.count, 0);

            const moves = rawMoves.map(m => ({
                uci: m.uci,
                san: m.san,
                weight: m.count,
                freq: totalW > 0 ? Math.round((m.count / totalW) * 100) : 0,
            }));

            send({
                type: 'book_moves',
                fen,
                moves,
                opening: entry?.name || 'Teoría de Aperturas',
                eco: entry?.eco || '',
                source: 'tsv'
            });
        } catch (e) {
            send({ type: 'book_moves', fen, moves: [], source: 'error', error: e.message });
        }
    },

    /**
     * Devuelve la configuración activa del servidor (modo de apertura, etc.).
     * Respuesta: { type: 'server_config', openingSource, polyglotLoaded }
     */
    'get_server_config': (msg, { send }) => {
        send({
            type: 'server_config',
            openingSource: OpeningService.source,
            bookSize: OpeningBook.size,
        });
    },
};

function handleClientMessage(msg, context) {
    const handler = handlers[msg.type];
    if (handler) {
        handler(msg, context);
    } else {
        context.send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    }
}

module.exports = { handleClientMessage };