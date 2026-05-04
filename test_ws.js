const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9001');

ws.on('open', () => {
    console.log('Connected');
    ws.send(JSON.stringify({ type: 'get_explorer', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' }));
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
    ws.close();
});

ws.on('error', (err) => {
    console.error('Error:', err);
});
