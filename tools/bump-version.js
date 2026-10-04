// Bump the app version after changing any app file:  node tools/bump-version.js
// - sw.js SHELL cache name, so installed phones fetch the new files
// - ?v= on the script/style tags in index.html, so no browser cache can serve an old copy
const fs = require('fs');
const path = require('path');

const app = path.join(__dirname, '..', 'app');
const swPath = path.join(app, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const m = sw.match(/orv-shell-v(\d+)/);
if (!m) throw new Error('SHELL version not found in sw.js');
const next = +m[1] + 1;
fs.writeFileSync(swPath, sw.replace(/orv-shell-v\d+/, `orv-shell-v${next}`));

const idxPath = path.join(app, 'index.html');
const html = fs.readFileSync(idxPath, 'utf8')
  .replace(/(<script src="(?!vendor\/)[^"?]+\.js)(\?v=\d+)?"/g, `$1?v=${next}"`)
  .replace(/(<link rel="stylesheet" href="style\.css)(\?v=\d+)?"/g, `$1?v=${next}"`);
fs.writeFileSync(idxPath, html);
console.log(`version ${next}`);
