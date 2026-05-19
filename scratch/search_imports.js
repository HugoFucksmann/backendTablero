const fs = require('fs');
const path = require('path');

function searchDir(dir, pattern) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (file !== 'node_modules' && file !== '.git') {
                searchDir(fullPath, pattern);
            }
        } else {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes(pattern)) {
                console.log(`Match in: ${fullPath}`);
            }
        }
    }
}

const startDir = 'e:/PROYECTOS/tableroAnalisisCompleto/tableroAnalisis/src';
console.log('Searching for "analysisBridge" in frontend...');
searchDir(startDir, 'analysisBridge');
