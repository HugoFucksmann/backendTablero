# Auditoría del Backend: Reporte de Bugs e Inconsistencias (Versión Validada y Ampliada)

Este documento presenta los hallazgos detallados de la auditoría profunda del backend (`backendTablero`). Se exponen los bugs críticos, las inconsistencias lógicas, la deuda técnica de dependencias, y los riesgos ocultos en el diseño del esquema de base de datos.

---

## 1. Bugs Críticos y Riesgos de Integración

### 1.1. Comparación Incompatible de Formato de Jugadas (SAN vs. LAN)
* **Archivo:** [moveClassifier.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/services/analysis/moveClassifier.js)
* **Línea:** 21
* **Código:**
  ```javascript
  const isEngineBest = before.bestMove === lan;
  ```
* **Descripción:** `before.bestMove` es la mejor jugada devuelta por Stockfish, la cual siempre está en formato **LAN** (Long Algebraic Notation, por ejemplo: `"e2e4"`). `lan` se obtiene a partir del historial enviado por el cliente:
  ```javascript
  const movePlayed = history[ply];
  const lan = typeof movePlayed === 'string' ? movePlayed : (movePlayed.lan ?? movePlayed.san);
  ```
  Si el cliente envía un historial que consiste puramente en strings de jugadas estándar (por ejemplo: `["e4", "e5", "Nf3", "Nc6"]`), que están en formato **SAN** (Standard Algebraic Notation), `lan` será `"e4"`. La comparación `"e2e4" === "e4"` evaluará a `false` de manera silenciosa.
* **Impacto:** Las mejores jugadas del motor en la apertura o posiciones simples se clasificarán incorrectamente como "Excelente" o menor en lugar de **"Mejor"** o **"Brillante"**, distorsionando completamente la precisión calculada para el usuario.
* **Mitigación actual:** Actualmente está mitigado porque el frontend envía objetos de jugada enriquecidos con la propiedad `.lan`. Sin embargo, es una vulnerabilidad grave en la API si se integra otro cliente o se realiza una refactorización en el formato del historial.
* **Solución recomendada:** Forzar la conversión de cualquier jugada del historial a formato LAN real antes de compararla, o asegurar mediante validación estricta de tipos de entrada en la API WebSocket que la propiedad `.lan` esté siempre presente y no vacía.

---

### 1.2. Script de Pruebas Roto (`test_ws.js`)
* **Archivo:** [test_ws.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/test_ws.js)
* **Línea:** 6
* **Código:**
  ```javascript
  ws.send(JSON.stringify({ type: 'get_explorer', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }));
  ```
* **Descripción:** El script de prueba de WebSocket envía una petición con el tipo de mensaje `'get_explorer'`. Sin embargo, en el controlador de mensajes del servidor (`messageHandlers.js`), el endpoint correcto se llama `'get_move_explorer'`.
* **Impacto:** Al ejecutar `node test_ws.js`, el servidor devuelve un error de tipo desconocido (`Unknown message type: get_explorer`), lo que invalida por completo el propósito de la suite de prueba local.
* **Solución recomendada:** Modificar el tipo en `test_ws.js` a `'get_move_explorer'`.

---

### 1.3. Resolución Anticipada de la Promesa de Lanzamiento de Subproceso
* **Archivo:** [engineProcess.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/core/engineProcess.js)
* **Líneas:** 33-72
* **Descripción:** El método `spawn()` devuelve una Promesa que ejecuta `spawn(STOCKFISH_PATH...)` y realiza un `resolve()` de manera inmediata al final del bloque síncrono (línea 71):
  ```javascript
  return new Promise((resolve, reject) => {
      try {
          this._proc = spawn(STOCKFISH_PATH, [], ...);
      } catch (err) { ... }
      // ... (escuchadores de eventos)
      resolve(); // <-- Se resuelve aquí inmediatamente
  });
  ```
  En Node.js, si `spawn` no puede ejecutar el binario (por ejemplo, si la ruta en `.env` es incorrecta, el binario está corrupto o faltan permisos de ejecución en Windows/Linux), la llamada síncrona rara vez lanza una excepción; en su lugar, emite un evento `'error'` de forma asíncrona en el siguiente ciclo de eventos.
* **Impacto:** La promesa se resolverá exitosamente (`fulfilled`), haciendo que el orquestador (`StockfishProcess`) prosiga con el flujo asumiendo que el motor está vivo. Fracciones de milisegundo después, el evento `'error'` se disparará, marcando al motor como `DEAD` y provocando llamadas fallidas o cuelgues asíncronos en los `isready` handshakes.
* **Solución recomendada:** Resolver la promesa solo después de recibir la primera señal de vida del motor (por ejemplo, cuando responda con su primer output, o tras el handshake UCI inicial), o bien controlar el estado asincrónicamente mediante promesas encadenadas con temporizadores.

---

## 2. Inconsistencias de Diseño en la Base de Datos (SQLite)

### 2.1. Peligro de Semántica Dual en la Columna `game_id`
* **Archivo:** [db.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/storage/db.js) (Esquema de tablas) y [analysisRepo.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/storage/repositories/analysisRepo.js) (Inserciones)
* **Descripción:** El backend utiliza dos identificadores para las partidas:
  1. `id` (UUID interno del registro generado en la base de datos).
  2. `gameId` (El identificador textual de la plataforma externa Lichess o Chess.com).
  
  En las subtablas relacionales, existe una inconsistencia crítica en qué representa la columna llamada `game_id`:
  * En **`phase_accuracy`**, **`move_quality`** y **`game_moves`**, `game_id` almacena el **UUID interno de la DB** (`entry.id`) y hace referencia a `analyses(id)`.
  * En **`analysis_full_data`**, `game_id` almacena el **ID de la plataforma externa** (`entry.gameId`) y hace referencia a `analyses(gameId)`.
* **Impacto:** Si un desarrollador intenta realizar una consulta `JOIN` personalizada uniendo `analysis_full_data` con `game_moves` bajo el campo común `game_id`, la consulta fallará silenciosamente sin retornar ninguna fila, debido a que los tipos de datos lógicos almacenados son incompatibles.
* **Solución recomendada:** Estandarizar las columnas. Modificar `analysis_full_data` para que use el UUID de la base de datos como clave foránea (`analyses(id)`), renombrando el campo si es necesario para evitar confusiones extremas.

---

### 2.2. Mezcla Híbrida de Convenciones de Estilo (camelCase vs. snake_case)
* **Archivo:** [db.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/storage/db.js)
* **Descripción:** Existe una falta de convención en la nomenclatura de columnas entre tablas del mismo motor relacional SQLite:
  * Las tablas principales **`analyses`** y **`puzzles`** usan estrictamente **`camelCase`** (`gameId`, `solvedCount`, `timeControl`, `whiteAccuracy`, `preBlunderFen`, `isOnlyMove`, `blunderSeverity`).
  * Las tablas relacionales secundarias **`phase_accuracy`**, **`move_quality`**, **`game_moves`** y **`analysis_full_data`** usan estrictamente **`snake_case`** (`game_id`, `move_san`, `move_time`, `remaining_time`, `error_time_class`, `full_json`).
* **Impacto:** Altamente propenso a errores al programar consultas SQL a mano, obligando al programador a recordar qué convención de casing se aplicó a cada tabla.
* **Solución recomendada:** Estandarizar todas las tablas a una única nomenclatura coherente (preferiblemente `snake_case` que es el estándar recomendado para SQL).

---

### 2.3. Ejecución de Migraciones Redundantes y Control de Flujo Frágil
* **Archivo:** [db.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/storage/db.js)
* **Líneas:** 120-163
* **Descripción:** Si se realiza una instalación limpia desde cero, la sentencia `CREATE TABLE` ya genera las tablas con las 27 columnas actualizadas. Sin embargo, el archivo ejecuta inmediatamente el bucle `migrations` que intenta agregar nuevamente cada una de esas columnas (`ALTER TABLE puzzles ADD COLUMN baseFen TEXT`, etc.).
* **Impacto:** SQLite arroja decenas de excepciones síncronas de "columna duplicada" las cuales se capturan y silencian de manera invisible en el bloque `catch (_) {}`. Esto no rompe el programa, pero representa un flujo de control de base de datos muy frágil y poco convencional que dificulta el diagnóstico de errores genuinos de migración.
* **Solución recomendada:** Utilizar una tabla auxiliar de metadatos (e.g., `schema_migrations`) para registrar qué parches de migración ya se aplicaron, o validar la existencia previa de las columnas en la tabla usando `PRAGMA table_info` antes de emitir la orden `ALTER`.

---

## 3. Inconsistencias de Configuración y Deuda Técnica de Código

### 3.1. Dependencia Muerta (`node-fetch`) en package.json
* **Archivo:** [package.json](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/package.json)
* **Línea:** 14
* **Código:**
  ```json
  "node-fetch": "^2.7.0",
  ```
* **Descripción:** La biblioteca `node-fetch` se encuentra declarada como dependencia activa del proyecto, pero no se importa (`require`) ni se utiliza en ninguna parte del código del backend actual.
* **Impacto:** Dado que el backend opera de manera local-first y offline (usando archivos TSV), esta dependencia es código muerto y un riesgo de seguridad o auditoría innecesario en el árbol de dependencias de producción.
* **Solución recomendada:** Remover `"node-fetch"` de `package.json` y ejecutar `npm prune` para limpiar los módulos de Node.

---

### 3.2. Variables de Entorno y Parámetros Muertos en el Archivo `.env`
* **Archivo:** [.env](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/.env) y [gameAnalysisCoordinator.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/services/analysis/gameAnalysisCoordinator.js)
* **Descripción:** Se definen las variables de entorno `OPENING_SOURCE=tsv` y `LICHESS_URL_MAESTRO=` en `.env`, pero no son leídas por ningún archivo de código del backend. 
  Adicionalmente, se sigue recuperando y pasando el parámetro `token` (para la API de Lichess) en `gameAnalysisCoordinator.js` (línea 109), pero la función final `OpeningService.detectOpeningsLocalTSV` ignora por completo esta propiedad ya que procesa el análisis a nivel local.
* **Impacto:** Confunde al administrador o desarrollador haciéndole creer que el backend requiere de una interfaz de red o un token de desarrollo de Lichess para funcionar, cuando la lógica actual está aislada y es 100% offline.
* **Solución recomendada:** Limpiar el archivo `.env` de propiedades obsoletas y remover el parámetro inútil `token` de los despachadores de la cola de análisis.

---

### 3.3. Uso de Parámetros Obsoletos de `chess.js`
* **Archivos y Líneas:**
  * [dataMiner.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/services/analysis/dataMiner.js#L90)
  * [puzzleFilters.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/services/puzzles/puzzleFilters.js#L20)
  * [puzzleFilters.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/services/puzzles/puzzleFilters.js#L64)
* **Descripción:** El objeto `{ sloppy: true }` es pasado a `.move()`. Esta opción fue removida en `chess.js` 1.x.x, ya que el parsing nativo lo realiza automáticamente.
* **Impacto:** Deuda técnica y confusión al desarrollador.
* **Solución recomendada:** Quitar la bandera obsoleta de todas las llamadas de movimiento.

---

### 3.4. IP Localhost Rígida
* **Archivo:** [server.js](file:///e:/PROYECTOS/tableroAnalisisCompleto/backendTablero/src/server.js#L71)
* **Descripción:** El servidor está enlazado únicamente a la dirección loopback `'127.0.0.1'`.
* **Impacto:** Impide conexiones de red externa (e.g. dispositivos móviles para pruebas de UI) u orquestación fluida de contenedores Docker.
* **Solución recomendada:** Parametrizar el enlace a `process.env.HOST || '127.0.0.1'`.
