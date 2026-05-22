import { StockfishProcess } from '../../core/stockfishProcess.js';
import { ChessMath } from '../../utils/chessMath.js';
import { mapLines, parsePgn } from '../../utils/analysisUtils.js';
import { GameAnalysisCoordinator } from './gameAnalysisCoordinator.js';
import { EnginePool } from './enginePool.js';

export interface LiveAnalysisCallbacks {
    onProgress?: (data: { score: number; mate: number | null; bestMove: string; moveIndex: number; lines: any[] }) => void;
    onResult?: (data: { score: number; mate: number | null; bestMove: string; moveIndex: number; lines: any[] }) => void;
    onError?: (err: any) => void;
}

export interface GameAnalysisCallbacks {
    onStatus?: (running: boolean) => void;
    onProgress?: (pct: number, label: string) => void;
    onMoveResult?: (data: any) => void;
    onOpeningDetected?: (data: any) => void;
    onComplete?: (accuracy: any, accuracyByPhase?: any, win?: number | null) => void;
    onCancelled?: () => void;
    onError?: (err: any) => void;
}

export interface BatchAnalysisCallbacks {
    onGameStarted?: (data: { gameIndex: number; total: number; gameId: string }) => void;
    onGameProgress?: (data: { gameIndex: number; pct: number; label: string }) => void;
    onGameComplete?: (data: { gameIndex: number; accuracy: any }) => void;
    onBatchComplete?: (data: { total: number }) => void;
    onCancelled?: () => void;
    onError?: (err: any) => void;
    onMoveResult?: (data: any) => void;
    onOpeningDetected?: (data: any) => void;
}

export class AnalysisQueue {
    public running: boolean;
    private _sf: StockfishProcess;
    private _ac: AbortController | null;
    private _gameCoordinator: GameAnalysisCoordinator;

    constructor() {
        this.running = false;
        this._sf = new StockfishProcess();
        this._ac = null;
        this._gameCoordinator = new GameAnalysisCoordinator();
    }

    public cancel(): void {
        this.running = false;
        if (this._ac) {
            console.log('[Engine] Cancelling current analysis');
            this._ac.abort();
            this._ac = null;
        }
        this._sf.stop();
    }

    public destroy(): void {
        console.log('[Engine] Destroying session Stockfish instance');
        this.cancel();
        this._sf.destroy();
    }

    /**
     * Analyzes a single position (Live mode).
     */
    public async analyzePosition(
        fen: string,
        moveIndex: number,
        config: any = {},
        callbacks: LiveAnalysisCallbacks = {}
    ): Promise<void> {
        const { onProgress, onResult, onError } = callbacks;

        this.cancel();
        
        try {
            await (this._sf as any)._initPromise;
        } catch {
            /* ignore — we'll re-init below */
        }

        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        const depth = config.depth ?? 18;
        const multiPv = config.multiPv ?? 3;

        try {
            await this._sf.init(config);
            if (signal.aborted) return;

            const isBlackTurn = fen.includes(' b ');

            const result = await this._sf.analyzePosition(
                fen,
                depth,
                signal,
                ({ score, mate, bestMove, lines }) => {
                    onProgress?.({
                        score: ChessMath.cpToVisualScore(score, mate, isBlackTurn),
                        mate,
                        bestMove,
                        moveIndex,
                        lines: mapLines(lines, isBlackTurn),
                    });
                },
                multiPv,
            );

            if (!signal.aborted) {
                const visualScore = ChessMath.cpToVisualScore(result.score, result.mate, isBlackTurn);
                console.log(`[Live] Position analyzed | Score: ${visualScore}`);

                onResult?.({
                    score: visualScore,
                    mate: result.mate,
                    bestMove: result.bestMove,
                    moveIndex,
                    lines: mapLines(result.lines, isBlackTurn),
                });
            }
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                onError?.(e);
            }
        } finally {
            this.running = false;
        }
    }

    /**
     * Analyzes a full game history.
     */
    public async analyzeGame(
        history: any[],
        currentIndex: number,
        gameId: string,
        engineConfig: any = {},
        callbacks: GameAnalysisCallbacks = {},
        startFen: string | null = null,
        extraInfo: any = {}
    ): Promise<void> {
        this.cancel();
        if (!history || history.length === 0) return;

        this._gameCoordinator = new GameAnalysisCoordinator();

        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        try {
            await this._gameCoordinator.run(
                history,
                currentIndex,
                gameId,
                engineConfig,
                {
                    ...callbacks,
                    signal,
                    startFen
                },
                extraInfo
            );
            
            if (signal.aborted) {
                console.log('[Game] Analysis cancelled — notifying client');
                callbacks.onCancelled?.();
            }
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                callbacks.onError?.(e);
            } else {
                console.log('[Game] Analysis cancelled (AbortError) — notifying client');
                callbacks.onCancelled?.();
            }
        } finally {
            this.running = false;
        }
    }

    /**
     * Analyzes multiple games sequentially.
     */
    public async analyzeGames(
        games: any[],
        engineConfig: any = {},
        callbacks: BatchAnalysisCallbacks = {}
    ): Promise<void> {
        const { onGameStarted, onGameProgress, onGameComplete, onBatchComplete, onCancelled, onError } = callbacks;

        this.cancel();
        if (!Array.isArray(games) || games.length === 0) return;

        this._ac = new AbortController();
        const { signal } = this._ac;
        this.running = true;

        console.log(`[Batch] Starting batch analysis of ${games.length} games`);

        const pool = new EnginePool(engineConfig);

        try {
            await pool.init();
            const batchEngines = pool.engines;
            console.log(`[Batch] Engine pool ready: ${pool.count} engine(s)`);

            for (let i = 0; i < games.length; i++) {
                if (signal.aborted) break;

                batchEngines.forEach(e => e.newGame());

                const game = games[i];
                const { history, gameId, pgn, startFen, playerColor, win, timeControl, opponent, gameDate } = game;

                let actualHistory = history;
                let actualStartFen = startFen;

                if (!actualHistory && pgn) {
                    const parsed = parsePgn(pgn);
                    actualHistory = parsed.history;
                    actualStartFen = parsed.startFen;
                    game.times = parsed.times;
                    if (!game.playerWhite && parsed.headers?.White) game.playerWhite = parsed.headers.White;
                    if (!game.playerBlack && parsed.headers?.Black) game.playerBlack = parsed.headers.Black;
                }

                if (!actualHistory || actualHistory.length === 0) {
                    console.warn(`[Batch] Game ${i} has no history/PGN, skipping.`);
                    continue;
                }

                onGameStarted?.({ gameIndex: i, total: games.length, gameId });

                this._gameCoordinator = new GameAnalysisCoordinator();

                await this._gameCoordinator.run(
                    actualHistory,
                    0,
                    gameId,
                    engineConfig,
                    {
                        onProgress: (pct, label) => onGameProgress?.({ gameIndex: i, pct, label }),
                        onMoveResult: (data) => callbacks.onMoveResult?.({ gameIndex: i, ...data }),
                        onOpeningDetected: (data) => callbacks.onOpeningDetected?.({ gameIndex: i, ...data }),
                        onComplete: (accuracy) => onGameComplete?.({ gameIndex: i, accuracy }),
                        signal,
                        startFen: actualStartFen
                    },
                    {
                        playerColor,
                        win,
                        timeControl,
                        times: game.times,
                        username: game.username,
                        playerWhite: game.playerWhite || null,
                        playerBlack: game.playerBlack || null,
                        opponent: opponent || game.opponent || null,
                        gameDate: gameDate || game.gameDate || null
                    },
                    batchEngines
                );

                if (signal.aborted) break;
            }

            if (signal.aborted) {
                onCancelled?.();
            } else {
                onBatchComplete?.({ total: games.length });
            }
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                onError?.(e);
            } else {
                onCancelled?.();
            }
        } finally {
            pool.destroy();
            console.log('[Batch] Engine pool destroyed');
            this.running = false;
        }
    }
}
export default AnalysisQueue;
