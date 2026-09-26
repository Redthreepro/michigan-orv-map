'use strict';
// National Weather Service forecasts for trip stops. Fetched while you have signal, saved for offline.

const WX_FRESH_MS = 3 * 3600 * 1000;   // refetch after 3 h when online
const WX_KEEP_MS = 7 * 86400 * 1000;   // drop saved forecasts older than a week

const wxKey = (lat, lng) => `wx:${lat.toFixed(2)},${lng.toFixed(2)}`;

async function forecast(lat, lng) {
  const key = wxKey(lat, lng);
  const saved = store.get(key, null);
  if (saved && (Date.now() - saved.at < WX_FRESH_MS || !navigator.onLine)) return saved;
  try {
    const point = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`).then((r) => r.json());
    const url = point.properties && point.properties.forecast;
    if (!url) return saved;
    const fc = await fetch(url).then((r) => r.json());
    const periods = (fc.properties.periods || []).slice(0, 8).map((p) => ({
      n: p.name, t: p.temperature, s: p.shortForecast, rain: p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value,
      wind: p.windSpeed, day: p.isDaytime,
    }));
    const obj = { at: Date.now(), periods };
    store.set(key, obj);
    return obj;
  } catch {
    return saved;
  }
}

function pruneWeather() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('orv.wx:')) continue;
      const v = JSON.parse(localStorage.getItem(k));
      if (!v || Date.now() - v.at > WX_KEEP_MS) localStorage.removeItem(k);
    }
  } catch {}
}
pruneWeather();

// Fill #trip-weather for the start, each overnight stop, and the end.
window.fillTripWeather = async () => {
  const el = document.getElementById('trip-weather');
  if (!el || !plan || plan.stops.length < 2) return;
  const picks = plan.stops.map((s, i) => ({ s, i })).filter(({ s, i }) => i === 0 || s.night || i === plan.stops.length - 1).slice(0, 5);
  el.innerHTML = '<h2>Weather</h2><p class="hint">Loading forecast…</p>';
  const rows = await Promise.all(picks.map(async ({ s, i }) => ({ s, i, f: await forecast(s.lat, s.lng) })));
  if (document.getElementById('trip-weather') !== el) return; // sheet re-rendered meanwhile
  if (!rows.some((r) => r.f)) {
    el.innerHTML = '<h2>Weather</h2><p class="hint">No forecast saved. Open this trip once with signal to save the forecast.</p>';
    return;
  }
  const oldest = Math.min(...rows.filter((r) => r.f).map((r) => r.f.at));
  const age = Date.now() - oldest;
  const when = new Date(oldest).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  el.innerHTML = '<h2>Weather</h2>' + rows.map(({ s, i, f }) => {
    const label = i === 0 ? 'Start' : s.night ? 'Camp' : 'End';
    if (!f) return `<div class="wx"><b>${label}: ${esc(s.name)}</b><small>No forecast saved</small></div>`;
    return `<div class="wx"><b>${label}: ${esc(s.name)}</b>` + f.periods.slice(0, 4).map((p) =>
      `<div class="wx-p"><span>${esc(p.n)}</span><b>${esc(String(p.t))}°</b><small>${esc(p.s)}${p.rain ? ` · ${esc(String(p.rain))}% rain` : ''}${p.day ? ` · wind ${esc(p.wind)}` : ''}</small></div>`).join('') + '</div>';
  }).join('') + `<p class="hint">National Weather Service forecast from ${when}${age > WX_FRESH_MS ? ' (saved; refreshes when you have signal)' : ''}.</p>`;
};
