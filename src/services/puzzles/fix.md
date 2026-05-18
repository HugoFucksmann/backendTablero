🔴 Crítico — Bugs reales con consecuencias
1. db.js — Foreign Keys declaradas pero nunca activadas
SQLite no activa FK constraints por defecto. Sin PRAGMA foreign_keys = ON, todo el ON DELETE CASCADE de phase_accuracy, move_quality, game_moves y analysis_full_data es decorativo. Cuando borrás un análisis, las filas hijas quedan huérfanas indefinidamente.
js// db.js — agregar inmediatamente después de abrir la conexión
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON'); // ← sin esto, los CASCADE no existen
2. db.js — FK referencia una columna no-PK
sqlFOREIGN KEY(game_id) REFERENCES analyses(gameId) ON DELETE CASCADE
--                                        ^^^^^^
--                                        no es la PK, es una columna UNIQUE
analysis_full_data.game_id apunta a analyses(gameId) en lugar de analyses(id). En SQLite funciona si la columna tiene un índice UNIQUE, pero es frágil y semánticamente incorrecto. Si en algún momento se cambia la constraint de gameId, esto rompe silenciosamente.
3. puzzleExtractor.js — Comparación UCI vs SAN siempre falsa
jsconst movePlayed = typeof history[ply] === 'string'
    ? history[ply]                          // ← podría ser SAN ("e4")
    : (history[ply].lan ?? history[ply].san);

const isEngineBest = before.bestMove === movePlayed;
// before.bestMove viene del engine → siempre UCI ("e2e4")
// Si history[ply] es un string SAN, nunca van a ser iguales
Cuando history contiene strings en SAN (el caso más común viniendo de PGN), isEngineBest siempre es false. Esto afecta EvaluationEngine.classifyMove y puede generar falsos candidatos a puzzle o clasificaciones incorrectas de jugadas.
4. messageHandlers.js — Inyección directa de JSON crudo sin validar
jsconst responseStr = `{"type":"full_analysis_data","gameId":${gameIdStr}${reqIdStr},"data":${rawJson}}`;
if (ws.readyState === ws.OPEN) ws.send(responseStr);
Si rawJson está corrupto en la BD (truncado, encoding roto, etc.), se envía un frame JSON malformado al cliente sin ningún aviso. El cliente recibe un mensaje que no puede parsear. Al menos debería haber un guard:
jsif (!rawJson || typeof rawJson !== 'string') {
    return send({ type: 'error', message: 'Stored data is corrupted' });
}

🟠 Importante — Comportamiento incorrecto o inesperado
5. openingService.js — IIFE asíncrona sin manejo de errores
js// En el path de cache:
(async () => {
    for (let i = 0; i < history.length; i++) {
        if (signal?.aborted) break;
        onPlyResolved(i, cachedBookPlies.has(i));
        if (i % 10 === 0) await new Promise(r => setImmediate(r));
    }
    if (!signal?.aborted) onOpeningDetected?.({ ... });
})();
// ← sin .catch() → Unhandled Rejection si onPlyResolved o onOpeningDetected tiran
Si cualquier callback lanza, el proceso recibe un UnhandledPromiseRejection. Dado que server.js tiene el listener global que solo loguea, esto podría pasar desapercibido.
6. analysisQueue.js — this.running no inicializado en el constructor
jsconstructor() {
    this._sf = new StockfishProcess();
    this._ac = null;
    this._gameCoordinator = new GameAnalysisCoordinator();
    // ← this.running nunca se inicializa, es undefined hasta el primer cancel()
}
No es un bug explosivo porque undefined es falsy, pero cualquier código que chequee queue.running antes del primer análisis obtiene undefined en lugar de false. Debería ser this.running = false en el constructor.
7. gameStore.js — save() permite que analysis pise id y createdAt
jsconst entry = {
    id: existing ? existing.id : randomUUID(),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    ...analysis,   // ← si analysis tiene id o createdAt, los sobreescribe
    fullData
};
Si el objeto analysis que llega incluye un campo id o createdAt (plausible dado que viene de afuera), los valores calculados arriba son ignorados. El orden correcto es que id y createdAt vayan después del spread, o que el spread los excluya explícitamente.
8. db.js — Sin WAL mode
better-sqlite3 usa journal mode DELETE por defecto. Con múltiples conexiones o escrituras concurrentes (análisis en batch + guardado), WAL evita bloqueos de escritura y mejora el throughput considerablemente:
jsdb.pragma('journal_mode = WAL');

🟡 Inconsistencias y deuda técnica
9. db.js — Schema y migraciones duplican columnas
El CREATE TABLE ya define eco, username y advancedMetrics. El array migrations intenta agregarlas con ALTER TABLE. En instancias nuevas el ALTER TABLE falla silenciosamente (bien), pero el código implica que esas columnas son "nuevas" cuando en realidad ya están en el schema base. Si alguien lee el schema para entender la estructura histórica, esto confunde.
10. server.js — runIntegrityCheck() no es awaited
jsGameStore.runIntegrityCheck(); // ← async, no awaited
Hoy no importa porque solo loguea OK. Pero si en algún momento ese método hace algo real (una query de integridad), el servidor podría arrancar antes de que termine.
11. messageHandlers.js — requestId duplicado en dos handlers
js// get_stats:
send({ type: 'stats_data', requestId: msg.requestId, stats: ... });
// send() en server.js ya agrega requestId por su cuenta → el campo se setea dos veces
No rompe nada (mismo valor), pero es ruido y podría confundir si alguna vez send() cambia su lógica.
12. openingBook.js — Campo moves: [] muerto en cada entrada del Map
jsconst entry = {
    eco, name, rootName,
    moves: []   // ← nunca se usa, nextMoves (Map) es lo que se popula
};
Se crea un array vacío por cada una de las miles de entradas del libro de aperturas y nunca se escribe ni lee. Memoria desperdiciada.
13. analysisQueue.js — analyzeGames no desestructura onOpeningDetected del top
jsconst { onGameStarted, onGameProgress, onGameComplete, onBatchComplete, onCancelled, onError } = callbacks;
// onMoveResult y onOpeningDetected se usan via callbacks.X?. directamente
Inconsistencia menor: onMoveResult y onOpeningDetected se acceden como callbacks.onMoveResult?.() mientras el resto está desestructurado. No rompe, pero es asimétrico.

Resumen rápido
#ArchivoSeveridadDescripción1db.js🔴FK constraints nunca activadas, orphaned rows garantizados2db.js🔴FK referencia analyses(gameId) en vez de analyses(id)3puzzleExtractor.js🔴isEngineBest siempre falso cuando history es SAN4messageHandlers.js🔴Raw JSON de BD se inyecta sin validar5openingService.js🟠IIFE async sin .catch() → Unhandled Rejection6analysisQueue.js🟠this.running sin inicializar7gameStore.js🟠Spread ...analysis puede pisar id y createdAt8db.js🟠Sin WAL mode9db.js🟡Schema y migraciones duplican columnas10server.js🟡runIntegrityCheck no awaited11messageHandlers.js🟡requestId doble en get_stats y get_stat_details12openingBook.js🟡Campo moves: [] muerto en cada entrada del Map13analysisQueue.js🟡onOpeningDetected/onMoveResult no desestructurados