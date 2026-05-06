# Hoja de ruta: De detección de errores a análisis conjunto

Basándome en la auditoría, acá está todo lo que se puede mejorar, ordenado por capas de complejidad creciente. Cada capa es independiente y entregable.

---

## 🟢 Capa 1 — Correcciones al clasificador actual
*Lo que está roto o incompleto hoy. Sin esto, las capas superiores tienen datos sucios.*

**1.1 — Etiqueta "Omisión" (Miss)**
La lógica es distinta a un error grave: el error no es que jugaste mal, es que *tenías algo muy bueno y lo ignoraste*. La condición es: evaluación antes del movimiento ≥ +3.0 WP, y la mejor línea de Stockfish incluía una secuencia de al menos 2 movimientos forzados (mate, captura ganadora, etc.), pero vos no la jugaste. Es una categoría *de oportunidad perdida*, no de degradación posicional.

**1.2 — Etiqueta "Gran jugada" (Great find)**
Condición inversa a la omisión: estabas en posición difícil (WP < 0.35), la mayoría de los movimientos legales empeoran, pero encontraste el único o uno de los pocos que mantiene la evaluación. Requiere MultiPV 3+ para confirmar que el movimiento jugado es el único que no deteriora.

**1.3 — Etiqueta "Brillante" más estricta**
Actualmente parece ser solo por umbral de WP. Una brillante real requiere: ser el único movimiento que gana en la posición, involucrar un sacrificio aparente (captura disponible que la mayoría evitaría), y que Stockfish confirme que las alternativas son peores. Sin los tres requisitos, es Excelente, no Brillante.

---

## 🟡 Capa 2 — Detección de motivos tácticos en partidas
*Extender la lógica que ya existe en `puzzleFilters.js` al flujo de análisis completo.*

**2.1 — Taxonomía de motivos**
Cada error debería tener un campo `tacticMotive` con valores como: `fork` (ataque doble), `pin` (clavada), `skewer` (espetón), `discoveredAttack`, `hangingPiece`, `backRankMate`, `trappedPiece`, `zwischenzug`. Esto se detecta analizando la posición resultante del movimiento del oponente que explotó tu error.

**2.2 — Método de detección**
El flujo sería: cuando Stockfish marca un error, tomás la *respuesta del oponente* (el movimiento que castiga), analizás qué cambió estructuralmente en el tablero (¿una pieza quedó desprotegida? ¿dos piezas atacadas simultáneamente?), y asignás el motivo. Chess.js ya te da acceso a piezas atacadas y clavadas, lo que simplifica esto.

**2.3 — Motivos posicionales (no solo tácticos)**
Para errores más sutiles: `weakenedKing` (jugada que deteriora la estructura defensiva del rey), `isolatedPawn` (creación de peón débil estructural), `tradeImbalance` (cambio que crea desequilibrio de piezas sin compensación). Estos son más difíciles de detectar automáticamente y pueden requerir heurísticas de chess.js.

---

## 🟡 Capa 3 — Umbrales dinámicos por fase y contexto
*El cambio más impactante en precisión del clasificador.*

**3.1 — Detección de fase de partida**
Tres fases con criterios claros:
- **Apertura**: jugadas 1–N mientras haya movimientos en el libro de aperturas, o hasta que todas las piezas menores estén desarrolladas
- **Medio juego**: desde fin de apertura hasta que la cantidad total de material baje de un umbral (por ejemplo, menos de 26 puntos de material combinado)
- **Final**: por debajo de ese umbral

**3.2 — Umbrales por fase**
En la apertura, una pérdida de 0.10 WP es una imprecisión real porque las posiciones son más cerradas y las opciones más claras. En el medio juego táctico, 0.10 WP puede ser ruido del motor. En el final, 0.05 WP puede ser la diferencia entre tablas y victoria. Los umbrales deberían escalar por un factor configurable según la fase.

**3.3 — Ajuste por agudeza posicional**
Si MultiPV 3 muestra que los tres mejores movimientos están dentro de 0.20 WP entre sí, la posición es tranquila y los umbrales normales aplican. Si hay una brecha grande entre la primera y segunda opción, la posición es aguda y una pequeña desviación es más grave. Esto ya casi lo tenés con `hasClearSolution` en los puzzles — es extenderlo al clasificador general.

---

## 🟠 Capa 4 — Enrichment de cada movimiento
*Metadatos adicionales que hacen posible el análisis conjunto después.*

**4.1 — Tiempo de pensamiento (si está disponible en PGN)**
Lichess y Chess.com incluyen el tiempo restante en el PGN (`%clk`). Esto permite etiquetar movimientos jugados en zeitnot vs. con tiempo disponible. Un blunder a los 3 segundos de reloj es un dato diferente a un blunder con 3 minutos.

**4.2 — Complejidad posicional del movimiento**
Un score calculado en base a: cantidad de piezas atacadas, cantidad de capturas disponibles, diferencia entre mejor y segunda opción (ambigüedad del motor). Esto te dice si el error fue en una posición fácil o compleja, lo que es crítico para el análisis conjunto posterior.

**4.3 — Movimiento del oponente que "provocó" el error**
Guardar no solo tu movimiento malo, sino el movimiento anterior del oponente que creó la amenaza. Esto es la semilla del análisis de patrones: si siempre el mismo tipo de movimiento del oponente precede a tus errores, ahí está el patrón.

**4.4 — FEN antes y después, con hash de estructura de peones**
Para la Capa 6 (clustering). El hash de estructura de peones permite agrupar posiciones similares sin comparar FEN exactos.

---

## 🔴 Capa 5 — Análisis de apertura como árbol propio
*Separar el análisis de apertura del resto porque tiene lógica propia.*

**5.1 — Registro de divergencia del libro**
Para cada partida, detectar en qué jugada exacta saliste del libro y *qué jugó el oponente* para provocarlo. Acumular esto en todas las partidas te da un ranking de "movimientos del oponente que más te sacan del libro".

**5.2 — Árbol de variantes personal**
Construir un grafo donde cada nodo es una posición (FEN) dentro de tu apertura habitual, y cada nodo tiene: cuántas veces pasaste por ahí, tu win rate en esa rama, y tu error rate. Esto es el "árbol de decisiones de tu apertura" mencionado antes — ahora técnicamente posible con los datos enriquecidos de las capas anteriores.

**5.3 — Detección de líneas problemáticas**
Automáticamente marcar las ramas del árbol donde tu error rate supera un umbral (por ejemplo, 40% de las veces cometés un error antes de la jugada 20 en esa variante).

---

## 🔴 Capa 6 — Análisis conjunto entre partidas
*El objetivo final. Solo es significativo con las capas anteriores completas.*

**6.1 — Clustering de posiciones de error**
Agrupar por hash de estructura de peones + motivo táctico + fase de partida. Si aparece un cluster con 8+ instancias, es un patrón sistemático, no ruido. El output sería: "Cometiste este tipo de error 11 veces, siempre con peones doblados en columna c en el medio juego".

**6.2 — Correlación error × contexto personal**
Cruzar errores con: tiempo de reloj disponible, fase de partida, ventaja/desventaja previa al error, hora del día (si el timestamp está en el PGN). Buscar cuál de estas variables tiene mayor correlación con tus blunders.

**6.3 — Fingerprint de respuestas del oponente**
Tomás todos los movimientos del oponente que precedieron tus errores (dato de Capa 4.3) y los clasificás por tipo: ¿son ataques directos? ¿cambios de estructura? ¿movimientos de ruptura? Si el 60% de tus errores ocurren después de un movimiento de ruptura de peones, el problema es gestión de tensión, no táctica.

**6.4 — Síntesis narrativa con LLM**
Con todos los datos estructurados de las capas anteriores, mandarle al modelo un resumen del corpus (no las partidas completas, sino los patrones detectados) y pedirle que genere un diagnóstico en lenguaje natural con ejemplos específicos. Esto convierte estadísticas en insight accionable.

---

## Orden sugerido para tu agente

```
Capa 1 → Capa 3 → Capa 2 → Capa 4 → Capa 5 → Capa 6
```

La Capa 3 antes que la 2 porque los umbrales dinámicos afectan qué se considera error, y eso determina sobre qué posiciones buscás motivos tácticos. Sin datos limpios en las primeras cuatro capas, el análisis conjunto de la 6 va a detectar patrones en ruido.