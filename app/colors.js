'use strict';
// Trail colors: "By trail type" (route / ATV trail / motorcycle...) or "Ridden vs not ridden"
// (everything you haven't ridden in one color, what you have in another). Every color can be changed.

const COLOR_DEFAULTS = {
  route: '#f28c28', trail: '#2fbf4a', mc: '#2b8cff', mccct: '#b05cff',
  ridden: '#00e676', unridden: '#ffc400', crew: '#19c3b0', track: '#ff2fd0',
};
const COLOR_LABELS = {
  route: 'ORV routes', trail: 'ORV / ATV trails', mc: 'Motorcycle trails', mccct: 'Cross Country Cycle Trail',
  ridden: 'Trails I\'ve ridden', unridden: 'Not ridden yet (in "Ridden vs not ridden")', crew: 'Crew\'s ridden trails', track: 'My ride lines',
};
const COLORS = { ...COLOR_DEFAULTS, ...store.get('colors', {}) };
let colorMode = store.get('colorMode', 'type');
const RIDE_GOAL_KINDS = ['route', 'trail', 'mc', 'mccct'];
window.COLORS = COLORS;

// the color a trail line is drawn in (app.js styleFor)
window.colorFor = (p) => (colorMode === 'progress' && RIDE_GOAL_KINDS.includes(p.t) ? COLORS.unridden : (KIND[p.t] || {}).color);

function applyColors() {
  for (const k of ['route', 'trail', 'mc', 'mccct']) KIND[k].color = COLORS[k];
  KIND.scramble.color = COLORS.route;
  const root = document.documentElement.style;
  for (const k of ['route', 'trail', 'mc', 'mccct']) root.setProperty('--' + k, COLORS[k]);
  root.setProperty('--ridden', COLORS.ridden);
  root.setProperty('--crew', COLORS.crew);
  root.setProperty('--track', COLORS.track);
  root.setProperty('--unridden-sw', COLORS.unridden);
  document.body.classList.toggle('progress-colors', colorMode === 'progress');
}
// redraw everything that uses these colors
function recolor() {
  applyColors();
  if (typeof restyle === 'function') restyle();
  if (window.drawProgress) drawProgress();
  if (window.drawCrewLayer) drawCrewLayer();
  if (window.recolorTracks) recolorTracks();
}
applyColors();

function colorsHtml() {
  return `<div class="seg" id="colormode-seg">
      <button data-mode="type" class="${colorMode === 'type' ? 'on' : ''}">By trail type</button>
      <button data-mode="progress" class="${colorMode === 'progress' ? 'on' : ''}">Ridden vs not ridden</button>
    </div>
    <p class="hint">${colorMode === 'progress' ? 'Every trail you haven\'t ridden is one color, everything you have is another.' : 'Each trail type has its own color. Ridden trails get a bright line with a dark border on top.'}</p>
    ${Object.keys(COLOR_DEFAULTS).filter((k) => colorMode === 'progress' ? !['route', 'trail', 'mc', 'mccct'].includes(k) : k !== 'unridden')
      .map((k) => `<label class="row color-row"><input type="color" data-color="${k}" value="${COLORS[k]}"><span>${COLOR_LABELS[k]}</span></label>`).join('')}
    <button class="ghost small" id="btn-colors-reset">Reset colors</button>`;
}
function drawColorsPanel() { $('#colors-body').innerHTML = colorsHtml(); }
drawColorsPanel();
$('#colors-body').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mode]');
  if (m) {
    colorMode = m.dataset.mode; store.set('colorMode', colorMode);
    // the point of this mode is seeing what you've ridden: make sure that layer is on
    if (colorMode === 'progress' && !shown.ridden) { shown.ridden = 1; store.set('shown', shown); const cb = document.querySelector('[data-kind="ridden"]'); if (cb) cb.checked = true; }
    recolor(); drawColorsPanel();
  }
  if (e.target.closest('#btn-colors-reset')) {
    Object.assign(COLORS, COLOR_DEFAULTS); store.set('colors', {});
    recolor(); drawColorsPanel();
  }
});
$('#colors-body').addEventListener('input', (e) => {
  const k = e.target.dataset.color;
  if (!k) return;
  COLORS[k] = e.target.value;
  const custom = {};
  for (const [key, v] of Object.entries(COLORS)) if (v !== COLOR_DEFAULTS[key]) custom[key] = v;
  store.set('colors', custom);
  recolor();
});
