const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:9001');

ws.on('open', () => {
    console.log('✅ Conectado al servidor de análisis');
    
    const history = [
        { san: 'e4', lan: 'e2e4' },
        { san: 'e5', lan: 'e7e5' }
    ];

    const engineConfig = {
        threads: 1,
        hash: 32,
        depth: 10,
        multiPv: 1
    };

    const analyzeGameMsg = {
        type: 'analyze_game',
        history,
        currentIndex: 2,
        gameId: 12345,
        engineConfig
    };

    console.log('🚀 Enviando analyze_game...');
    ws.send(JSON.stringify(analyzeGameMsg));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    console.log('<-', msg.type);
    
    if (msg.type === 'complete') {
        console.log('\n✅ analyze_game complete. Simulating makeMove...');
        
        console.log('-> cancel 1');
        ws.send(JSON.stringify({ type: 'cancel' }));
        console.log('-> cancel 2');
        ws.send(JSON.stringify({ type: 'cancel' }));
        
        const analyzePosMsg = {
            type: 'analyze_position',
            fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            moveIndex: 2,
            depth: 10,
            multiPv: 2
        };
        console.log('-> analyze_position with multiPv 2');
        ws.send(JSON.stringify(analyzePosMsg));
    }

    if (msg.type === 'position_result') {
        console.log('\n🏆 Resultado Final de position_result:');
        console.log(`- Score: ${msg.score}`);
        console.log(`- Líneas alternativas (debería ser 2): ${msg.lines.length}`);
        
        console.log('\n✅ Prueba completada con éxito. Cerrando...');
        ws.close();
    }
});

ws.on('error', (err) => {
    console.error('❌ Error de conexión:', err.message);
});
