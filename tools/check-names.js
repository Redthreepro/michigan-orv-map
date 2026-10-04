// The app's scripts share one global scope (plain <script> tags). A top-level name defined in two files
// either throws (let/const) or silently replaces the earlier one (function). Run before testing:
//   node tools/check-names.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'app');
const order = [...fs.readFileSync(path.join(dir, 'index.html'), 'utf8').matchAll(/<script src="(?!vendor\/)([^"?]+)[^"]*"/g)].map((m) => m[1]);
const seen = {};
let problems = 0;
for (const file of order) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var|class)\s+(\w+)/gm)) {
    const name = m[1] || m[2];
    if (seen[name] && seen[name] !== file) {
      console.log(`DUPLICATE top-level name "${name}" in ${seen[name]} and ${file}`);
      problems++;
    } else seen[name] = file;
  }
}
try {
  new Function(order.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n'));
} catch (err) {
  console.log('SYNTAX:', err.message);
  problems++;
}
console.log(problems ? `${problems} problem(s)` : `ok: ${order.length} scripts, no clashes`);
process.exit(problems ? 1 : 0);
