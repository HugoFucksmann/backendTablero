'use strict';

function parseInfoLine(line) {
    if (!line.startsWith('info') || !line.includes('score')) return null;

    const mpvMatch   = line.match(/multipv (\d+)/);
    const depthMatch = line.match(/depth (\d+)/);
    const cpMatch    = line.match(/score cp (-?\d+)/);
    const mateMatch  = line.match(/score mate (-?\d+)/);
    const pvMatch    = line.match(/ pv (.+)/);

    const pv   = pvMatch ? pvMatch[1].trim() : '';
    const move = pv.split(' ')[0] ?? '';

    return {
        multipv: mpvMatch  ? parseInt(mpvMatch[1])  : 1,
        depth:   depthMatch ? parseInt(depthMatch[1]) : 0,
        score:   cpMatch    ? parseInt(cpMatch[1])    : 0,
        mate:    mateMatch  ? parseInt(mateMatch[1])  : null,
        pv,
        move,
    };
}

function parseBestmoveLine(line) {
    if (!line.startsWith('bestmove')) return null;
    const bm = line.split(' ')[1] ?? '';
    return { bestMove: bm === '(none)' ? '' : bm };
}

module.exports = { parseInfoLine, parseBestmoveLine };
