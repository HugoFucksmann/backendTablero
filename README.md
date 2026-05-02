# ♟️ Chess Analysis Backend (Native)

Este es el motor de análisis nativo para el **Tablero de Ajedrez Pro**. Al ejecutarse directamente en Node.js, permite utilizar la potencia total de tu CPU y almacenamiento local, superando las limitaciones de rendimiento y memoria de las versiones WebAssembly (WASM) que corren en el navegador.

## 🚀 Características Principales

- **⚡ Rendimiento Nativo**: Utiliza Stockfish compilado para tu sistema operativo, permitiendo análisis más profundos en menos tiempo.
- **⚡ Rendimiento Nativo**: Utiliza Stockfish compilado para tu sistema operativo, permitiendo análisis más profundos en menos tiempo.
- **🧩 Extractor de Puzzles**: Genera automáticamente tácticas de entrenamiento a partir de tus partidas basándose en errores graves detectados por el motor.
- **🌍 Detección de Aperturas Híbrida**: Combina un libro local ultra-rápido (TSV) con la API de Lichess para una identificación instantánea de teoría.
- **📊 Clasificación Avanzada**: Lógica de clasificación de jugadas al estilo Chess.com (*Brillante*, *Mejor*, *Excelente*, *Bueno*, *Imprecisión*, *Error*, *Error Grave*).
- **🔄 Multi-Cliente**: Soporta múltiples conexiones simultáneas vía WebSockets.

## 🛠️ Instalación y Uso

### 1. Requisitos
Asegúrate de tener instalado Stockfish en tu sistema:
```bash
sudo apt install stockfish  # Para Ubuntu/Linux Mint/Debian
```

### 2. Configuración
Clona este repositorio e instala las dependencias:
```bash
npm install
```

### 3. Ejecución
Inicia el servidor WebSocket:
```bash
npm start
```
El servidor escuchará por defecto en `ws://localhost:9001`.

## ⚙️ Variables de Entorno

Puedes configurar el comportamiento del servidor mediante variables de entorno:

| Variable | Descripción | Defecto |
|----------|-------------|---------|
| `PORT` | Puerto del servidor WebSocket | `9001` |
| `STOCKFISH_PATH` | Ruta al ejecutable de Stockfish | `stockfish` |

## 🧩 Integración con el Frontend

En el tablero de ajedrez, selecciona **"Backend Nativo"** en la configuración del motor. El frontend se conectará automáticamente a este servidor y delegará todas las tareas pesadas de procesamiento.

---
Desarrollado con ❤️ para amantes del ajedrez y el código de alto rendimiento.
