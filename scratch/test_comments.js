const { Chess } = require('chess.js');

const pgn = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.05.08"]
[White "Player1"]
[Black "Player2"]
[Result "1-0"]
[TimeControl "180"]

1. e4 { [%clk 0:03:00] } 1... e5 { [%clk 0:02:59] } 2. Nf3 { [%clk 0:02:58] } 2... Nc6 { [%clk 0:02:57] } 1-0`;

const chess = new Chess();
chess.loadPgn(pgn);

const history = chess.history({ verbose: true });
const game = new Chess();

history.forEach((move, i) => {
    game.move(move.san);
    const comment = game.getComment();
    console.log(`Move ${i+1}: ${move.san} | Comment: ${comment}`);
});
