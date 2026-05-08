# ♟️ Chess Analysis Backend (Native)

[![Node.js](https://img.shields.io/badge/Node.js-20+-68a063.svg)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003b57.svg)](https://www.sqlite.org/)
[![Stockfish](https://img.shields.io/badge/Engine-Stockfish-4b4b4b.svg)](https://stockfishchess.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Este es el motor de análisis nativo y servidor de persistencia para el **Tablero de Ajedrez Pro**. Diseñado para maximizar el rendimiento, se ejecuta directamente en el host para aprovechar la potencia total de la CPU y el almacenamiento local, superando las limitaciones de las soluciones basadas puramente en navegador.

## 🚀 Características Principales

- **⚡ Motor Stockfish Nativo**: Ejecución directa del binario Stockfish para análisis ultra-profundos y multihilo sin las restricciones de memoria de WASM.
- **🗄️ Persistencia Robusta**: Utiliza `better-sqlite3` para almacenar un historial completo de análisis, partidas y estadísticas de usuario con alto rendimiento.
- **🧩 Pipeline de Puzzles**: Algoritmo avanzado que identifica errores graves (*Blunders*) en tus partidas y extrae automáticamente puzzles tácticos personalizados.
- **🌍 Detección de Aperturas Híbrida**: Combina un libro local de aperturas (TSV) con la API de Lichess para identificación instantánea de teoría.
- **🔄 Cola de Procesamiento**: Sistema de gestión de tareas para análisis masivos (Bulk Import) sin bloquear el servidor.
- **🎯 Fuente de Verdad Única**: Centraliza toda la lógica de validación (Chess.js), cálculos de precisión y clasificación de jugadas.

## 🛠️ Stack Tecnológico

- **Runtime**: Node.js (CommonJS)
- **Database**: SQLite (`better-sqlite3`)
- **Protocolo**: WebSockets (`ws`)
- **Chess Engine**: Stockfish (Comunicación vía UCI)
- **Logic**: Chess.js v1.4

## ⚙️ Instalación y Configuración

### 1. Requisitos Previos
Debes tener instalado Stockfish en tu sistema:
```bash
# Ubuntu/Debian
sudo apt install stockfish

# macOS
brew install stockfish
```

### 2. Instalación
Clona el repositorio e instala las dependencias:
```bash
npm install
```

### 3. Variables de Entorno
Crea un archivo `.env` en la raíz (opcional):
```env
PORT=9001
STOCKFISH_PATH=stockfish
DB_PATH=./data/chess_stats.db
```

### 4. Ejecución
```bash
npm start
```
El servidor iniciará un WebSocket en `ws://localhost:9001`.

## 🏗️ Estructura del Proyecto

- `/src/services`: Lógica de negocio (Análisis, Puzzles, Aperturas).
- `/src/database`: Gestión de persistencia y esquemas SQLite.
- `/src/engine`: Orquestación del proceso Stockfish y comunicación UCI.
- `/data`: Almacenamiento local para la base de datos y libros de aperturas.

## 🤝 Integración
Este backend está diseñado para trabajar en conjunto con el [Frontend del Tablero de Análisis](https://github.com/HugoFucksmann/tableroAnalisis). El frontend se conecta automáticamente al puerto 9001 al detectar que el motor local está disponible.

---
Desarrollado con enfoque en rendimiento y precisión técnica por **ElColof**.
