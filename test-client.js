const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:9001');

ws.on('open', () => {
    console.log('✅ Conectado al servidor de análisis');
    
    // Posición inicial de prueba
    const testMsg = {
        type: 'analyze_position',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moveIndex: 0,
        depth: 15,
        multiPv: 3
    };

    console.log('🚀 Enviando posición de prueba (Apertura)...');
    ws.send(JSON.stringify(testMsg));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    
    if (msg.type === 'position_progress') {
        console.log(`⏳ Analizando... Profundidad: ${msg.lines[0]?.depth || '?'} | Score: ${msg.score}`);
    } 
    
    if (msg.type === 'position_result') {
        console.log('\n🏆 Resultado Final:');
        console.log(`- Score: ${msg.score}`);
        console.log(`- Mejor jugada: ${msg.bestMove}`);
        console.log(`- Líneas alternativas: ${msg.lines.length}`);
        
        console.log('\n✅ Prueba completada con éxito. Cerrando...');
        ws.close();
    }
});

ws.on('error', (err) => {
    console.error('❌ Error de conexión:', err.message);
    console.log('Asegúrate de que el servidor esté corriendo con "npm start"');
});

ws.on('close', () => {
    process.exit(0);
});
