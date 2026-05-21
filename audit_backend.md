# 🔍 Reporte de Auditoría: Backend del Sistema de Análisis de Ajedrez

Este documento detalla los hallazgos de la auditoría realizada sobre el backend (`backendTablero`). Se evaluó la alineación entre la especificación descrita en `architecture_backend.md` y la implementación real del código fuente, así como la existencia de bugs, inconsistencias de lógica o de flujo.

---

## 1. Evaluación de `architecture_backend.md` como Guía

El archivo `architecture_backend.md` es sumamente útil como mapa conceptual general (especialmente para entender el flujo del engine y las fórmulas matemáticas de Win Probability). Sin embargo, **está desactualizado y omitió cambios significativos de refactorización**. Si un desarrollador nuevo (o un agente de IA) intentara guiarse exclusivamente por él, se encontraría con errores de importación y de diseño de datos muy graves.

Actualmente, presenta una **desalineación del 30-40%** con respecto al estado real del repositorio.

---

## 2. Inconsistencias y Desalineaciones (Arquitectura vs. Código)

A continuación, se listan los puntos donde la documentación y la realidad no coinciden:

### 2.1 Nombre del Archivo de Entrada (`service.js` vs. `server.js`)
*   **En la especificación:** El servidor WebSocket es referenciado constantemente como `service.js` (en el diagrama Mermaid, en las reglas críticas y en la secuencia de startup).
*   **En la realidad:** El archivo físico no existe en la raíz ni en `src/`. El entrypoint real es `src/server.js` (como lo define `package.json` en `"start": "node src/server.js"`).

### 2.2 Persistencia de Puzzles (`puzzles.json` vs. SQLite)
*   **En la especificación:**
    *   Describe un flujo donde `puzzle_solved` busca en un archivo `puzzles.json` para incrementar `solvedCount` en memoria y guardarlo a disco.
    *   Define una sección llamada `🗄️ Schema de Puzzles (puzzles.json)` con un contrato limitado de solo 11 campos.
*   **En la realidad:**
    *   La base de datos SQLite centraliza todo. No existe `puzzles.json` en el flujo activo (fue migrado y eliminado por `migrate_puzzles.js`).
    *   `PuzzleStore` y `PuzzleRepo` manejan la persistencia directamente en la tabla `puzzles` de SQLite.

### 2.3 Contrato de Datos de Puzzles Incompleto
*   **En la especificación:** El esquema de puzzles solo lista campos básicos de identificación (`id`, `fen`, `solutionSequence`, `wpLoss`, etc.).
*   **En la realidad:** El backend implementa minería de datos enriquecidos (`DataMiner.js`). La tabla `puzzles` en `src/storage/db.js` y el proceso de extracción guardan mucha más información clave que el front-end podría consumir:
    *   `baseFen`, `contextMoves`, `originalContinuation`, `preBlunderFen` (contexto extendido).
    *   `puzzleType` (ej: `"mate"`, `"tactical_blunder"`).
    *   `mateIn` (número de jugadas para el mate).
    *   `blunderSeverity` (severidad del error).
    *   `tensionIndex`, `attackedSquares` (complejidad de la posición).
    *   `isOnlyMove`, `criticalityGap` (si es jugada única).
    *   `tacticalMotifs` (ej: `["capture", "check", "mate"]` en formato JSON).

### 2.4 Endpoints de WebSocket Omitidos en el Contrato API
El manejador de mensajes entrantes (`src/handlers/messageHandlers.js`) soporta un abanico mucho mayor de mensajes WebSocket del que está documentado.
*   **Mensajes entrantes omitidos en la documentación:**
    *   `analyze_games` (análisis en lote).
    *   `clear_cache` (limpieza de caché de aperturas).
    *   `get_stats` y `get_stat_details` (usados para el dashboard de estadísticas, filtros de tiempo, etc.).
    *   `get_analyses` (paginación de partidas guardadas).
    *   `get_analysed_ids` (lista ligera de IDs de partidas ya analizadas).
    *   `delete_analyses` (eliminación en lote).
    *   `get_full_analysis` (recuperación del JSON completo).
    *   `get_move_explorer` (explorador posicional basado en FEN).
    *   `get_book_moves` (movimientos sugeridos del libro TSV local).
    *   `get_server_config` (configuración activa del server).
*   **Mensajes salientes omitidos en la documentación:**
    *   Respuestas de lotes: `batch_analysis_started`, `batch_analysis_progress`, `batch_analysis_game_complete`, `batch_analysis_complete`, `batch_analysis_cancelled`, `batch_move_result`.
    *   Respuestas de estadísticas y explorador: `stats_data`, `stat_details_data`, `analyses_list`, `analysed_ids`, `analyses_deleted`, `full_analysis_data`, `move_explorer_data`, `book_moves`, `server_config`.

### 2.5 Lógica Real de `OpeningService`
*   **En la especificación:** Dice que cuenta con "Fallback Lichess: Endpoint explorer.lichess.ovh/lichess" y una lógica de parada que "se detiene tras 2 movimientos no-libro consecutivos".
*   **En la realidad:** `src/services/openings/openingService.js` fue refactorizado para usar **exclusivamente** el libro TSV local. Se eliminó por completo el fallback de Lichess y no hay ninguna lógica de detención anticipada por jugadas consecutivas fuera de libro; el loop procesa secuencialmente todas las jugadas del historial hasta el límite físico `MAX_BOOK_PLY = 30`. Tampoco existe el umbral de `MIN_THEORY_GAMES = 230,000` en el código.

### 2.6 Dependencias Omitidas en el Diagrama Mermaid
*   `puzzleExtractor.js` depende de `dataMiner.js`, `puzzleFilters.js` y `sqliteStore.js` (para el bypass de base de datos), pero estas conexiones no figuran en el diagrama.
*   `GameAnalysisCoordinator` depende de `EnginePool`, `AnalysisWorkerLoop`, `advancedMetricsCalculator` y `persistenceBuilder` para su flujo, pero estos módulos auxiliares no se muestran en las dependencias.

---

## 3. Bugs e Inconsistencias Lógicas Detectadas en el Código

Durante la revisión línea a línea del flujo del backend, se detectaron los siguientes problemas de lógica:

### 3.1 🐛 Bug en la Detección de Presión de Tiempo (`moveClassifier.js`)
En `src/services/analysis/moveClassifier.js` (líneas 30-48), se clasifica la jugada en base al tiempo empleado:
```javascript
// Línea 30
const isBlunder = label === 'Error' || label === 'Error grave' || label === 'Imprecisión';
if (isBlunder) {
    if (remainingTime !== undefined && remainingTime !== null && remainingTime < 40) {
        errorTimeClass = 'time_pressure';
    } ...
}

if (isBlunder && moveTime !== undefined && moveTime !== null) { // <--- PROBLEMA CRÍTICO
    if (moveTime < 3) label = 'Insta-move Blunder';
    else if (moveTime > 30) label = 'Deep-think Blunder';
    
    if (remainingTime !== undefined && remainingTime !== null && remainingTime < 10) {
        label = 'Time Pressure Error';
    }
}
```
*   **El problema:** Si `moveTime` es `undefined` (lo cual es normal para los dos primeros movimientos de la partida, o si el PGN importado carece de anotaciones de reloj específicas para esa jugada pero sí provee el `remainingTime` general), el segundo bloque `if (isBlunder && moveTime !== undefined ...)` **se omite completamente**.
*   **Consecuencia:** Un jugador con menos de 10 segundos en su reloj (`remainingTime < 10`) que cometa un error grave **no recibirá la etiqueta `'Time Pressure Error'`** a menos de que su `moveTime` esté definido. La regla de presión extrema debería evaluarse de manera independiente al tiempo consumido en el movimiento específico.

### 3.2 Inconsistencia en la Asignación de Hilos por Defecto
*   En `src/core/stockfishProcess.js`, se define el número predeterminado de hilos como `Math.max(1, CPUs - 1)`.
*   Sin embargo, en `src/services/analysis/enginePool.js` (que inicializa el pool para análisis de partidas completas y en lote), si `engineConfig.threads` no se provee, se recurre a:
    `const totalThreads = engineConfig.threads ?? 1;`
*   Esto anula la heurística de optimización multihilo por defecto y fuerza a Stockfish a correr en un único hilo a menos que el cliente envíe explícitamente una configuración de hilos.

### 3.3 Redundancia en `advancedMetricsCalculator.js`
En `src/services/analysis/advancedMetricsCalculator.js` (línea 92), se evalúa si una jugada es un error del usuario:
```javascript
const isUserError = m.isWhiteMove === isUserWhite && 
    (m.label === 'Error' || m.label === 'Error grave' || m.label === 'Imprecisión' || 
     ['Error', 'Error grave', 'Imprecisión', 'Insta-move Blunder', 'Deep-think Blunder', 'Time Pressure Error'].includes(m.label));
```
*   La primera condición `(m.label === 'Error' || m.label === 'Error grave' || m.label === 'Imprecisión')` es un subconjunto redundante del array `.includes(...)` que se evalúa justo después. No rompe el código, pero es código muerto/redundante.

### 3.4 Exclusión del label `'Error'` en la métrica `timeManagement` de Blunders
En `advancedMetricsCalculator.js` (línea 147):
```javascript
const isBlunderLabel = [
    'Error grave', 'Insta-move Blunder',
    'Deep-think Blunder', 'Time Pressure Error',
].includes(m.label);

if (isBlunderLabel) {
    blunderTimeSum += m.moveTime;
    blunderCount++;
}
```
*   Si el usuario comete un error clasificado como `'Error'` (Mistake simple con pérdida de Win Probability entre 0.10 y 0.20) y tardó por ejemplo 15 segundos en realizarlo (por lo que su etiqueta no se reclasificó a `'Deep-think Blunder'` ni `'Insta-move'`), este error **es excluido** del cálculo del tiempo promedio consumido en errores (`avgBlunderTime`).
*   Solo se promedian los "Errores graves" (Blunders absolutos) y las variantes reclasificadas por tiempo. Sería conveniente aclarar en la arquitectura si esta exclusión es intencional o si se debe incluir también la categoría `'Error'` dentro de las métricas de gestión de tiempo.

---

## 4. Conclusiones y Recomendaciones de Corrección

Para alinear el sistema y asegurar su robustez, se recomienda llevar a cabo el siguiente plan de trabajo:

1.  **Corregir el Bug de Presión de Tiempo (`moveClassifier.js`):**
    Reestructurar las condicionales en `moveClassifier.js` para desacoplar el chequeo de `remainingTime < 10` de la existencia de `moveTime`.
2.  **Actualizar `architecture_backend.md`:**
    *   Renombrar las referencias de `service.js` a `src/server.js`.
    *   Reemplazar la sección de `puzzles.json` por la especificación de la tabla SQLite `puzzles`, detallando todas las columnas enriquecidas por `DataMiner`.
    *   Completar las tablas de Contrato WebSocket con todas las peticiones entrantes y salientes soportadas por `messageHandlers.js`.
    *   Ajustar la sección de `Opening Service` para eliminar las menciones a Lichess API y Polyglot, reflejando el flujo TSV local puro.
3.  **Unificar Defaults de Hilos:**
    Hacer que `EnginePool` lea el default dinámico de `StockfishProcess` (que usa la cantidad de CPUs del sistema) en lugar de forzar `1` de manera estática.
