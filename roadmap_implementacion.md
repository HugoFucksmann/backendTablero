# 🚀 Hoja de Ruta: Sistema de Análisis Avanzado y Persistencia

Este documento detalla el plan de implementación para transformar el backend actual en un motor de análisis profundo con persistencia de datos y generación de perfiles estadísticos.

---

## 🛠️ Infraestructura Base: Persistencia de Análisis
Antes de iniciar las capas, implementaremos el motor de guardado para que ningún análisis se pierda.

*   **Archivo**: `gameStore.js`
*   **Destino**: `data/analyses.json`
*   **Funcionalidad**: Guardar el resultado final de cada `analyze_game` incluyendo precisión, conteo de etiquetas (errores, brillantes, etc.) y metadatos de la partida (fecha, apertura).

## 🟡 Etapa 2: Umbrales Dinámicos y Detección de Fase
*Objetivo: Ajustar la sensibilidad del motor según el contexto de la partida.*

### 2.1 — Detección Automática de Fase
*   **Apertura**: Mientras exista en el `OpeningService` o ply < 12.
*   **Final**: Cuando el material total en el tablero (excluyendo peones) sea ≤ 13 puntos por bando.
*   **Medio Juego**: Estado intermedio.

### 2.2 — Calibración de Umbrales
*   Se aplicarán multiplicadores de sensibilidad a la pérdida de WP:
    *   **Finales**: Mayor sensibilidad (un error pequeño es crítico).
    *   **Apertura**: Sensibilidad moderada (enfocada en salir de la teoría).
    *   **Medio Juego**: Sensibilidad estándar.

---

## 🟡 Etapa 3: Taxonomía de Motivos Tácticos
*Objetivo: Explicar el "por qué" de cada error.*

### 3.1 — Análisis de Castigo
*   Cuando se detecta un `Error` o `Error grave`, el sistema analizará el movimiento de respuesta del motor (la "refutación").
*   **Motivos a detectar**:
    *   `hangingPiece`: Dejaste una pieza sin defensa.
    *   `fork`: Permitiste un ataque doble.
    *   `pin`: Te clavaron una pieza.
    *   `backRank`: Debilidad en la última fila.
*   **Implementación**: Nueva utilidad `tacticDetector.js` usando `chess.js`.

---

## 🟠 Etapa 4: Enriquecimiento de Datos (Enrichment)
*Objetivo: Capturar contexto externo para encontrar patrones.*

### 4.1 — Tiempo de Reloj
*   Extraer y almacenar el tiempo restante (`%clk` o similar) para cada jugada desde el objeto `history` del frontend.
*   Permitirá identificar errores por "apuro de tiempo" (Zeitnot).

### 4.2 — Complejidad de la Posición
*   Calcular un score de complejidad basado en: piezas atacadas, tensión central y cantidad de capturas legales.

---

## 🔴 Etapa 5: Perfil de Usuario y Análisis Conjunto
*Objetivo: Generar insights a partir de múltiples partidas guardadas en `analyses.json`.*

### 5.1 — Dashboard de Estadísticas (Perfil)
*   **Endpoint**: `get_user_profile`
*   **Métricas**:
    *   Evolución de precisión (últimas 20 partidas).
    *   Mapa de calor de errores por apertura.
    *   Motivo táctico más frecuente (ej: "Sueles fallar en clavadas").

### 5.2 — Clustering de Errores
*   Agrupar errores similares usando un **Pawn Structure Hash**. Esto detectará si el usuario siempre comete el mismo error en estructuras de peones específicas (ej. peón de dama aislado).

---

## 📝 Notas Técnicas Importantes
1.  **MultiPV**: El análisis completo deberá subir a `multiPv: 3` para habilitar las etiquetas de la Etapa 1.
2.  **Persistencia**: Se usará un sistema de guardado atómico para evitar corrupción del JSON en escrituras simultáneas.
3.  **LLM Ready**: Los datos se guardarán de forma estructurada para que en la fase final el sistema pueda generar un informe narrativo ("Estás jugando bien la apertura, pero pierdes el control en el medio juego táctico...").
