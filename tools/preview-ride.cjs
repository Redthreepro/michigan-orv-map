// Development-only replay server. Never included in the deployed app shell.
// node tools/preview-ride.cjs -> http://127.0.0.1:8767
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../app');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const fakeGps = `<script>
const previewWatches = new Map(); let previewWatchId = 0;
Object.defineProperty(navigator, 'geolocation', { value: {
  watchPosition(ok) { const id = ++previewWatchId; previewWatches.set(id,ok); return id; },
  clearWatch(id) { previewWatches.delete(id); }
}});
Object.defineProperty(navigator, 'serviceWorker', { value: { addEventListener() {}, register: async()=>{ throw new Error('Replay preview does not install a service worker'); } } });
</script>`;
const replay = `<div id="ride-preview-controls" style="position:fixed;left:8px;bottom:80px;z-index:1400;background:#111;color:#fff;padding:6px;border-radius:8px;font:12px system-ui">
Synthetic GPS test · <button id="preview-start">Start test ride</button> <button id="preview-next">Next GPS point</button> <button id="preview-hide">Hide test controls</button></div>
<script>
let previewPath=[], previewIndex=0;
function nextPreviewFix() {
  if (!previewPath.length) return;
  const p = previewPath[previewIndex], next = previewPath[Math.min(previewIndex+1,previewPath.length-1)];
  const fix={timestamp:Date.now(),coords:{latitude:p[0],longitude:p[1],accuracy:5,altitude:250,speed:6,heading:bearingDeg(p,next)}};
  for (const callback of previewWatches.values()) callback(fix);
  previewIndex=Math.min(previewIndex+1,previewPath.length-1);
}
document.getElementById('preview-start').onclick=async()=>{
  store.set('welcomed',1); closeSheets(); setRig(50);
  plan={stops:[{lat:44.65791,lng:-84.71111,name:'Test start'},{lat:44.73161,lng:-85.18421,name:'Test end'}]};
  await computePlan({show:false}); previewPath=planLegs.flatMap(leg=>leg.path||[]); previewIndex=0;
  if (!previewPath.length) { toast('Test route unavailable'); return; }
  if (currentRec()) resumeRec(); else await startRec(); startNav(); nextPreviewFix();
};
document.getElementById('preview-next').onclick=nextPreviewFix;
document.getElementById('preview-hide').onclick=()=>document.getElementById('ride-preview-controls').hidden=true;
</script>`;
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8767');
  const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(root, '.' + name);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(path.basename(file) === 'index.html' ? data.toString().replace('<head>', '<head>'+fakeGps).replace('</body>', replay+'</body>') : data);
  });
}).listen(8767, '127.0.0.1', () => console.log('Synthetic ride preview: http://127.0.0.1:8767'));
