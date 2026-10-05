'use strict';
// Photos and trail reports. Both are waypoints:
//   photo:  { type:'photo', photos:[photoId], rideId? }       (start/end of a ride, or any spot along the way)
//   report: { type:'report', r:'mud'|..., at: timestamp, photos? }   (mud, washout, downed tree...)
// Any waypoint can carry photos. Photo files live in IndexedDB 'photos' ({ id, blob, thumb }), shrunk to
// ~1600 px so a season of rides doesn't fill the phone.

const REPORTS = { mud: 'Mud', washout: 'Washout', tree: 'Downed tree', water: 'Water over trail', gate: 'Gate closed', hazard: 'Other hazard' };
const PHOTO_MAX = 1600, THUMB_MAX = 320;

// ---------- photo files ----------
const putPhoto = (rec) => tx('readwrite', (s) => s.put(rec), 'photos');
const getPhoto = (id) => tx('readonly', (s) => s.get(id), 'photos');
const delPhoto = (id) => tx('readwrite', (s) => s.delete(id), 'photos');
async function shrink(file, max, quality) {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}
// opens the camera (or the photo library); resolves to a stored photo id, or null if cancelled
function takePhoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = (v) => { input.remove(); resolve(v); };
    input.addEventListener('cancel', () => done(null));
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return done(null);
      try {
        toast('Saving photo…');
        const id = 'p' + Date.now();
        await putPhoto({ id, blob: await shrink(f, PHOTO_MAX, 0.8), thumb: await shrink(f, THUMB_MAX, 0.7), at: Date.now() });
        done(id);
      } catch { toast('Could not save that photo'); done(null); }
    });
    input.click();
  });
}
async function dropPhotos(wp) { for (const id of wp.photos || []) await delPhoto(id).catch(() => {}); }
window.dropPhotos = dropPhotos;

// thumbnails: render placeholders, then fill them in
const urls = new Map();
async function photoUrl(id, thumb) {
  const key = id + (thumb ? 't' : '');
  if (urls.has(key)) return urls.get(key);
  const r = await getPhoto(id).catch(() => null);
  if (!r) return null;
  const u = URL.createObjectURL(thumb ? r.thumb : r.blob);
  urls.set(key, u);
  return u;
}
function stripHtml(ids, caption) {
  if (!ids || !ids.length) return '';
  return `<div class="photo-strip">${ids.map((id) => `<button class="photo-thumb" data-photo="${esc(id)}" data-cap="${esc(caption || '')}" aria-label="Open photo"></button>`).join('')}</div>`;
}
async function hydrate(root) {
  for (const b of root.querySelectorAll('.photo-thumb:not(.ready)')) {
    const u = await photoUrl(b.dataset.photo, true);
    if (u) { b.style.backgroundImage = `url("${u}")`; b.classList.add('ready'); } else b.remove();
  }
}
// full-size viewer
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.photo-thumb');
  if (!b) return;
  e.stopPropagation();
  const u = await photoUrl(b.dataset.photo, false);
  if (!u) return;
  const v = $('#photo-view');
  v.querySelector('img').src = u;
  v.querySelector('figcaption').textContent = b.dataset.cap || '';
  v.hidden = false;
}, true);
$('#photo-view').addEventListener('click', () => { $('#photo-view').hidden = true; });

async function saveWp(wp) {
  await tx('readwrite', (s) => s.put(wp), 'waypoints');
  await loadWaypoints();
}
async function addPhotoTo(wp) {
  const id = await takePhoto();
  if (!id) return false;
  wp.photos = [...(wp.photos || []), id];
  await saveWp(wp);
  toast('Photo added');
  return true;
}

// ---------- the Mark button: photo, plain mark, or a trail report ----------
function showMarkMenu() {
  $('#sheet-body').innerHTML = `<h3>Mark this spot</h3>
    <div class="mark-grid">
      <button data-a="photo" class="mk-photo">${GLYPH.photo}<span>Photo</span></button>
      <button data-a="pin"><svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/></svg><span>Just mark it</span></button>
    </div>
    <h2>Report a trail problem</h2>
    <div class="mark-grid">${Object.entries(REPORTS).map(([k, v]) => `<button data-r="${k}">${GLYPH.report}<span>${v}</span></button>`).join('')}</div>
    <p class="hint">Saved at your GPS spot. Tap the pin on the map later to add a note or photo.</p>`;
  $('#sheet-body').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'pin') {
      closeSheets();
      const wp = await dropWaypoint('pin', 'Mark ' + timeNow());
      if (wp) toast(`Saved "${wp.name}". Rename it in Waypoints.`);
    }
    if (b.dataset.a === 'photo') {
      const id = await takePhoto();
      closeSheets();
      if (!id) return;
      const wp = await dropWaypoint('photo', 'Photo ' + timeNow(), { photos: [id] });
      if (wp) toast('Photo saved on the map at this spot');
    }
    if (b.dataset.r) {
      closeSheets();
      const wp = await dropWaypoint('report', REPORTS[b.dataset.r], { r: b.dataset.r, at: Date.now() });
      if (wp) toast(`${REPORTS[b.dataset.r]} reported here. Tap the pin to add a photo or note.`);
    }
  };
  openSheet('#sheet');
}
window.showMarkMenu = showMarkMenu;

// ---------- start / end photos ----------
let startPhotoT = null;
window.offerStartPhoto = () => {
  $('#photo-bar').hidden = false;
  clearTimeout(startPhotoT);
  startPhotoT = setTimeout(() => { $('#photo-bar').hidden = true; }, 5 * 60000); // offered for the first 5 minutes
};
$('#photo-bar').addEventListener('click', async (e) => {
  $('#photo-bar').hidden = true;
  if (e.target.closest('.x')) return;
  const id = await takePhoto();
  if (id) { await dropWaypoint('photo', 'Ride start', { photos: [id] }); toast('Start photo saved'); }
});
window.offerEndPhoto = (ride, mi) => {
  $('#sheet-body').innerHTML = `<h3>Ride saved</h3><p>${esc(ride.name)} · ${mi.toFixed(1)} mi</p>
    <button class="primary" data-a="photo">${GLYPH.photo} Take an end photo</button>
    <div class="rec-row"><button class="ghost" data-a="details">Ride details</button><button class="ghost" data-a="done">Done</button></div>`;
  $('#sheet-body').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'done') closeSheets();
    if (a === 'details' && window.showRideDetails) showRideDetails(ride);
    if (a === 'photo') {
      const id = await takePhoto();
      if (!id) return;
      const last = ride.segs.flat().filter((p) => p[3]).pop();
      const wp = { id: 'w' + Date.now(), lat: last ? last[0] : map.getCenter().lat, lng: last ? last[1] : map.getCenter().lng,
        name: 'Ride end', type: 'photo', note: `On ${ride.name}`, rideId: ride.id, photos: [id] };
      await saveWp(wp);
      closeSheets();
      toast('End photo saved');
    }
  };
  openSheet('#sheet');
};

// ---------- extras for a waypoint's sheet (places.js) ----------
const ago = (ts) => {
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : new Date(ts).toLocaleDateString();
};
window.spotExtras = (wp) => {
  let html = '';
  if (wp.type === 'report') html += `<p class="hint">Reported ${ago(wp.at || 0)}. Conditions change, so it may be cleared by now.</p>`;
  html += stripHtml(wp.photos, wp.name);
  html += `<div class="rec-row"><button class="ghost" data-a="photo">${wp.photos && wp.photos.length ? 'Add another photo' : 'Add a photo'}</button>${wp.type === 'report' ? '<button class="ghost" data-a="cleared">It\'s cleared</button>' : ''}</div>`;
  setTimeout(() => hydrate($('#sheet-body')), 0);
  return html;
};
window.spotClick = async (wp, a) => {
  if (a === 'photo') { if (await addPhotoTo(wp)) showPlace({ lat: wp.lat, lng: wp.lng, n: wp.name }, wp); return true; }
  if (a === 'cleared') {
    await dropPhotos(wp);
    await tx('readwrite', (s) => s.delete(wp.id), 'waypoints');
    closeSheets(); await loadWaypoints(); toast('Report removed');
    return true;
  }
  return false;
};

// ---------- photos in ride details (details.js) ----------
window.ridePhotosHtml = (t) => {
  const ids = new Set([t.id, ...(t.parts || []).map((p) => p.meta.id)]);
  const wps = (waypoints || []).filter((w) => ids.has(w.rideId) && w.photos && w.photos.length)
    .sort((a, b) => (a.photos[0] < b.photos[0] ? -1 : 1));
  if (!wps.length) return '';
  setTimeout(() => hydrate(document), 0);
  return '<h2>Photos</h2>' + `<div class="photo-strip">${wps.flatMap((w) => w.photos.map((id) =>
    `<button class="photo-thumb" data-photo="${esc(id)}" data-cap="${esc(w.name)}" aria-label="Open photo"></button>`)).join('')}</div>`;
};

// ---------- photos in the waypoint edit sheet ----------
async function drawWpPhotos() {
  const box = $('#wp-photos');
  box.innerHTML = editing ? stripHtml(editing.photos, editing.name) : '';
  hydrate(box);
}
window.drawWpPhotos = drawWpPhotos;
$('#btn-wp-photo').addEventListener('click', async () => {
  const id = await takePhoto();
  if (!id || !editing) return;
  editing.photos = [...(editing.photos || []), id];
  drawWpPhotos();
});

// ---------- backup: photos ride along as data URLs ----------
window.photosForBackup = async () => {
  const all = (await tx('readonly', (s) => s.getAll(), 'photos').catch(() => [])) || [];
  const toUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  const out = [];
  for (const p of all) out.push({ id: p.id, at: p.at, blob: await toUrl(p.blob), thumb: await toUrl(p.thumb) });
  return out;
};
window.restorePhotos = async (list) => {
  for (const p of list || []) {
    const blob = await (await fetch(p.blob)).blob(), thumb = await (await fetch(p.thumb)).blob();
    await putPhoto({ id: p.id, at: p.at, blob, thumb });
  }
};
