require('dotenv').config();
const fetch = globalThis.fetch ?? require('node-fetch');

async function test() {
    const token = process.env.LICHESS_TOKEN;
    const url = 'https://explorer.lichess.ovh/lichess?fen=rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR%20w%20KQq%20-%200%201';

    try {
        console.log(`Consultando a Lichess... ${token ? '(con token)' : '(sin token)'}`);
        const headers = {
            'User-Agent': 'ChessTest/1.0',
            'Accept': 'application/json'
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(url, { headers });
        console.log('Status:', res.status);
        console.log('Content-Type:', res.headers.get('content-type'));

        const text = await res.text();
        if (!res.ok) {
            console.error('❌ Error HTTP:', res.status);
            if (res.status === 401) {
                console.error('Lichess ahora requiere un token de API para usar el Explorer.');
                console.error('Crea uno en: https://lichess.org/account/oauth/token');
            } else {
                console.error('Respuesta:', text.substring(0, 200));
            }
            return;
        }

        try {
            const data = JSON.parse(text);
            console.log('✅ Conexión exitosa!');
            console.log('Apertura:', data.opening?.name || 'No detectada');
            console.log('Jugadas encontradas:', data.moves?.length || 0);
        } catch (e) {
            console.error('❌ Error parseando JSON:', e.message);
            console.error('Cuerpo de la respuesta:', text.substring(0, 500));
        }
    } catch (e) {
        console.error('❌ Error de red/fetch:', e);
    }
}
test();