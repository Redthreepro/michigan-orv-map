'use strict';
// Online features, on the Red Three Pro Firebase project "orv-map" (rules: /firestore.rules):
//   sign-in (Google or email), Ride Watch (a live link for family at home), and crews
//   (shared ridden trails + trail reports). Everything else in the app works without any of this.
// Firebase is loaded only when needed (~700 KB, cached for offline). Writes made with no signal are
// queued on the phone by Firestore and sent when a connection comes back (Starlink, a bar of LTE...).
// Firestore can't store arrays inside arrays, so point lists are flat: [lat, lng, t, lat, lng, t, ...].

const FB_CONFIG = {
  apiKey: 'AIzaSyBguxU2znTuUpOpqIOjPQUkC7aoasio1s8',
  authDomain: 'orv-map.firebaseapp.com',
  projectId: 'orv-map',
  storageBucket: 'orv-map.firebasestorage.app',
  messagingSenderId: '1060406683876',
  appId: '1:1060406683876:web:7f75d4284f7344eceba4f1',
};
// local testing only: http://localhost:8765/?emu=1 talks to the Firebase emulator instead of the real project
const FB_EMU = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]emu=1/.test(location.search);
// Sign in with Apple: turn on after the Apple developer account is active and the Apple provider is set up in Firebase
const APPLE_SIGNIN = false;
const WATCH_EVERY_MS = 60000;   // send position about once a minute while riding
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups

let fb = null;   // { auth, db, FV }
let me = null;   // signed-in Firebase user

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
function cloud() {
  if (!cloud.p) {
    cloud.p = (async () => {
      for (const m of ['app', 'auth', 'firestore']) await loadScript(`vendor/firebase-${m}-compat.js?v=12.19.0`);
      firebase.initializeApp(FB_EMU ? { ...FB_CONFIG, projectId: 'demo-orv', apiKey: 'demo-key' } : FB_CONFIG);
      const auth = firebase.auth(), db = firebase.firestore();
      if (FB_EMU) { auth.useEmulator('http://127.0.0.1:9099'); db.useEmulator('127.0.0.1', 8080); }
      else { try { await db.enablePersistence({ synchronizeTabs: true }); } catch {} } // keeps writes made with no signal
      fb = { auth, db, FV: firebase.firestore.FieldValue };
      await new Promise((res) => { const off = auth.onAuthStateChanged((u) => { off(); me = u; res(); }); });
      auth.onAuthStateChanged((u) => { me = u; store.set('cloud', u ? 1 : 0); onUserChanged(); });
      try { await auth.getRedirectResult(); } catch {}
      return fb;
    })().catch((err) => { cloud.p = null; throw err; });
  }
  return cloud.p;
}
const myName = () => (me && (me.displayName || (me.email || '').split('@')[0])) || 'Rider';
function randomId(n, chars = 'abcdefghijkmnpqrstuvwxyz23456789') {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return [...a].map((x) => chars[x % chars.length]).join('');
}
const flat = (pts) => pts.flatMap((p) => p);
const fmtAgo = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
const cloudErr = (e) => {
  const c = (e && e.code) || '';
  return c.includes('wrong-password') || c.includes('invalid-credential') ? 'Wrong email or password.'
    : c.includes('user-not-found') ? 'No account with that email. Tap "Create account".'
      : c.includes('email-already-in-use') ? 'That email already has an account. Tap "Sign in".'
        : c.includes('weak-password') ? 'Use a password with at least 6 characters.'
          : c.includes('invalid-email') ? 'That email doesn\'t look right.'
            : c.includes('network') || c.includes('unavailable') ? 'No connection right now. Try again with signal.'
              : c.includes('popup-closed') || c.includes('cancelled') ? 'Sign-in cancelled.'
                : (e && e.message) || 'Something went wrong.';
};

// ---------- sign in ----------
async function signInGoogle() {
  const p = new firebase.auth.GoogleAuthProvider();
  try { await fb.auth.signInWithPopup(p); }
  catch (e) {
    // home-screen apps on iPhone can't always open the Google popup: go by redirect instead
    if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(e.code || '')) return fb.auth.signInWithRedirect(p);
    throw e;
  }
}
async function signInApple() {
  const p = new firebase.auth.OAuthProvider('apple.com');
  p.addScope('email'); p.addScope('name');
  try { await fb.auth.signInWithPopup(p); }
  catch (e) {
    if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(e.code || '')) return fb.auth.signInWithRedirect(p);
    throw e;
  }
}
async function ensureName() {
  if (me && !me.displayName) {
    const n = prompt('Your name (your crew and family see this)', myName());
    if (n && n.trim()) await me.updateProfile({ displayName: n.trim().slice(0, 40) });
  }
}
function onUserChanged() {
  if (me && store.get('cloudUid', null) && store.get('cloudUid', null) !== me.uid) {
    W.id = null; W.active = false; store.set('watchId', null); store.set('watchRide', null); store.set('sosSent', 0);
    C.code = null; store.set('crew', null);
  }
  if (me) store.set('cloudUid', me.uid);
  if (me) { startCrew(); resumeWatch(); } else { stopCrew(); }
  refreshCloudSheet();
}

// ---------- the Crew & Ride Watch sheet ----------
async function showCloud() {
  $('#sheet-body').onclick = null;
  if (!fb) {
    $('#sheet-body').innerHTML = '<h3 id="cloud-view">Crew &amp; Ride Watch</h3><p class="hint">Connecting…</p>';
    openSheet('#sheet');
    try { await cloud(); } catch { $('#sheet-body').innerHTML = '<h3>Crew &amp; Ride Watch</h3><p class="hint warn">Can\'t connect right now. This needs signal the first time.</p>'; return; }
  }
  let html = '<h3 id="cloud-view">Crew &amp; Ride Watch</h3>';
  if (!me) {
    html += `<p class="hint">Sign in to share your rides live with family at home, and to ride as a crew: combined trail progress and shared trail reports. Your rides stay on your phone either way.</p>
      ${APPLE_SIGNIN ? '<button class="primary apple" data-a="apple">Continue with Apple</button>' : ''}
      <button class="primary" data-a="google">Continue with Google</button>
      <h2>Or with email</h2>
      <input id="cl-email" class="field" type="email" placeholder="Email" autocomplete="email">
      <input id="cl-pass" class="field" type="password" placeholder="Password (6+ characters)" autocomplete="current-password">
      <div class="rec-row"><button class="ghost" data-a="signin">Sign in</button><button class="ghost" data-a="create">Create account</button></div>
      <button class="link-btn" data-a="forgot">Forgot password?</button>
      <p class="hint">By signing in you agree to the <a href="privacy.html" target="_blank" rel="noopener">terms and privacy policy</a>.</p>`;
  } else {
    html += `<p class="hint">Signed in as <b>${esc(myName())}</b>${me.email ? ` (${esc(me.email)})` : ''} · <button class="link-btn" data-a="rename">Change name</button> · <button class="link-btn" data-a="signout">Sign out</button></p>`;
    html += watchHtml() + crewHtml();
    html += `<h2>Account</h2><p class="hint"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy &amp; terms</a></p>
      <button class="ghost danger" data-a="delete-account">Delete my account</button>`;
  }
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').onclick = cloudClick;
  $('#sheet-body').onchange = (e) => {
    if (e.target.id === 'cl-auto') { store.set('watchAuto', e.target.checked ? 1 : 0); W.auto = e.target.checked; }
    if (e.target.id === 'cl-crewmap') { shown.crew = e.target.checked ? 1 : 0; store.set('shown', shown); drawCrew(); }
  };
  openSheet('#sheet');
}
window.showCloud = showCloud;
async function cloudClick(e) {
  const b = e.target.closest('button');
  if (!b || !b.dataset.a) return;
  const a = b.dataset.a;
  try {
    if (a === 'google') { await signInGoogle(); await ensureName(); }
    if (a === 'apple') { await signInApple(); await ensureName(); }
    if (a === 'signin' || a === 'create') {
      const em = $('#cl-email').value.trim(), pw = $('#cl-pass').value;
      if (!em || !pw) return toast('Enter your email and a password');
      if (a === 'signin') await fb.auth.signInWithEmailAndPassword(em, pw);
      else await fb.auth.createUserWithEmailAndPassword(em, pw);
      await ensureName();
    }
    if (a === 'forgot') {
      const em = ($('#cl-email').value || '').trim() || prompt('Your email');
      if (em) { await fb.auth.sendPasswordResetEmail(em); toast('Password reset email sent'); }
      return;
    }
    if (a === 'rename') { const n = prompt('Your name (your crew and family see this)', myName()); if (n && n.trim()) { await me.updateProfile({ displayName: n.trim().slice(0, 40) }); await renameEverywhere(); } }
    if (a === 'signout') { if (!confirm('Sign out? Live sharing and crew sync stop until you sign in again.')) return; await stopWatch('ended'); await fb.auth.signOut(); }
    if (a === 'delete-account') return deleteAccount();
    if (a === 'watch-setup') await setupWatch();
    if (a === 'watch-send') await sendWatchLink();
    if (a === 'watch-now') { if (window.isRecording && isRecording()) await beginWatch(currentRide()); }
    if (a === 'watch-stop') await stopWatch('ended');
    if (a === 'watch-new') { if (confirm('Make a new link? The old link stops working, so you\'ll need to send the new one.')) await setupWatch(true); }
    if (a === 'crew-create') await createCrew();
    if (a === 'crew-join') await joinCrew();
    if (a === 'crew-send') await sendCrewCode();
    if (a === 'board-mi' || a === 'board-new') { boardSort = a === 'board-new' ? 'new' : 'mi'; store.set('boardSort', boardSort); }
    if (a === 'trip-load') return loadCrewTrip(C.trips.find((t) => t.id === b.dataset.id));
    if (a === 'trip-del') { const t = C.trips.find((x) => x.id === b.dataset.id); if (t && confirm(`Remove "${t.name}" for the whole crew?`)) await fb.db.collection('crews').doc(C.code).collection('trips').doc(t.id).delete(); }
    if (a === 'crew-leave') { if (confirm('Leave this crew? Your rides stay on your phone.')) await leaveCrew(); }
  } catch (err) { toast(cloudErr(err)); }
  showCloud();
}

// ---------- delete my account (App Store rule: deleting has to be possible from inside the app) ----------
async function deleteAccount() {
  if (!confirm('Delete your account? This removes everything of yours online: your family link, your crew progress, trail reports, photos and shared rides. Your rides and waypoints on this phone stay.')) return;
  if (!confirm('Are you sure? This can\'t be undone.')) return;
  toast('Deleting…');
  const uid = me.uid, db = fb.db;
  try {
    if (W.id) {
      await stopWatch('ended');
      await deleteWatch(W.id);
      W.id = null; store.set('watchId', null);
    }
    if (C.code) {
      const crew = db.collection('crews').doc(C.code);
      const mine = await crew.collection('reports').where('by', '==', uid).get();
      for (const d of mine.docs) {
        for (const pid of d.data().photos || []) await crew.collection('photos').doc(pid).delete().catch(() => {});
        await d.ref.delete();
      }
      for (const d of (await crew.collection('trips').where('by', '==', uid).get()).docs) await d.ref.delete();
      await crew.collection('ridden').doc(uid).delete().catch(() => {});
      const cd = (await crew.get()).data();
      const others = Object.keys((cd && cd.members) || {}).filter((m) => m !== uid);
      if (cd && cd.owner === uid) {
        // hand the crew to someone else, or remove it if you were the only one
        if (others.length) await crew.update({ owner: others[0], ['members.' + uid]: fb.FV.delete() });
        else await crew.delete();
      } else await crew.update({ ['members.' + uid]: fb.FV.delete() });
      stopCrew();
      C.code = null; store.set('crew', null); C.doc = null; C.ridden.clear(); C.reports = []; C.trips = [];
      drawCrew(); drawCrewReports(); refreshTripChip();
    }
  } catch (err) { toast('Could not remove everything (' + cloudErr(err) + '). Try again with signal.'); return; }
  try {
    await me.delete();
    toast('Your account and online data are deleted');
  } catch (e) {
    if ((e.code || '').includes('requires-recent-login')) {
      await fb.auth.signOut();
      toast('Your online data is removed. To finish, sign in once more and tap Delete my account again (a safety check).');
    } else toast(cloudErr(e));
  }
  showCloud();
}

// ---------- Ride Watch (rider side) ----------
// One family link per rider (bookmark it once). Each ride resets it: rideKey says which points belong to this ride.
const W = { id: store.get('watchId', null), auto: !!store.get('watchAuto', 1), active: false, rideKey: null, buf: [], timer: null, fix: null, sentAt: 0 };
const watchUrl = () => new URL(`watch.html?id=${W.id}`, location.href).href;
function watchHtml() {
  let h = '<h2>Ride Watch: live link for family</h2>';
  if (!W.id) {
    return h + `<p class="hint">Send someone at home a link. While you ride they see where you are on a map. If you lose signal it shows where you <i>probably</i> are (based on your trip and speed) until real updates come through again.</p>
      <button class="primary" data-a="watch-setup">Set up my family link</button>`;
  }
  const riding = window.isRecording && isRecording();
  h += `<p class="hint">${W.active ? `<b>Sharing this ride live.</b> Last sent ${W.sentAt ? fmtAgo(Date.now() - W.sentAt) : 'not yet'}${navigator.onLine ? '' : ' (no signal: updates are saved and will send when you get signal)'}.`
    : riding ? 'You\'re recording but not sharing this ride.' : 'Your link is ready. It goes live when you start recording a ride.'}</p>
    <button class="primary" data-a="watch-send">Send my family link</button>
    <label class="row"><input type="checkbox" id="cl-auto" ${W.auto ? 'checked' : ''}> Share every ride automatically when I start recording</label>
    <div class="rec-row">${W.active ? '<button class="ghost" data-a="watch-stop">Stop sharing this ride</button>' : riding ? '<button class="ghost" data-a="watch-now">Share this ride now</button>' : ''}<button class="ghost" data-a="watch-new">Make a new link</button></div>`;
  return h;
}
async function deleteWatch(id) {
  const ref = fb.db.collection('watch').doc(id);
  for (const d of (await ref.collection('pts').get()).docs) await d.ref.delete();
  await ref.delete();
}
// points from earlier rides on this link aren't needed: the family map only shows the current ride
async function purgeOldPoints(keep) {
  try {
    const q = await fb.db.collection('watch').doc(W.id).collection('pts').get();
    for (const d of q.docs) if (d.data().rideKey !== keep) d.ref.delete().catch(() => {});
  } catch {}
}
async function setupWatch(fresh) {
  if (W.id && fresh) { try { await deleteWatch(W.id); } catch {} }
  W.id = randomId(20);
  await fb.db.collection('watch').doc(W.id).set({ owner: me.uid, name: myName(), status: 'idle', created: Date.now() });
  store.set('watchId', W.id);
  if (window.isRecording && isRecording() && W.auto) await beginWatch(currentRide());
  toast('Your family link is ready. Tap "Send my family link".');
}
async function sendWatchLink() {
  const url = watchUrl(), text = `Follow my ORV rides live (opens a map): ${url}`;
  if (navigator.share) { try { await navigator.share({ title: `${myName()}'s ride`, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Link copied. Paste it in a text.'); } catch { prompt('Copy this link and text it:', url); }
}
const currentRide = () => (window.currentRec ? currentRec() : null);
// the planned route, so the family map can estimate where you are with no signal
function planLine() {
  let pts = [];
  if (typeof plan !== 'undefined' && plan && plan.stops.length >= 2 && planLegs.length) pts = planLegs.flatMap((r) => r.path || []);
  else if (typeof selItems !== 'undefined') pts = selItems.filter((s) => s.dots).flatMap((s) => s.lines.flat());
  if (pts.length < 2) return [];
  const step = Math.max(1, Math.ceil(pts.length / 400));
  const out = pts.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return flat(out.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]));
}
async function beginWatch(rec) {
  if (!rec || !W.id || !me) return;
  await cloud();
  W.active = true; W.rideKey = rec.id; W.buf = [];
  store.set('watchRide', rec.id);
  const sos = !!store.get('sosSent', 0);
  // merge, so an emergency alert already on the link survives the new ride starting
  await fb.db.collection('watch').doc(W.id).set({ owner: me.uid, name: myName(), title: rec.name, rideKey: rec.id, started: rec.start,
    ...(sos ? {} : { status: rec.paused ? 'paused' : 'riding', statusAt: Date.now() }), plan: planLine(), mi: 0, mph: 0, last: null,
    ended: fb.FV.delete(), sent: Date.now() }, { merge: true }).catch(() => {});
  purgeOldPoints(rec.id);
  clearInterval(W.timer);
  W.timer = setInterval(flushWatch, WATCH_EVERY_MS);
  W.sentAt = Date.now();
}
async function flushWatch(extra) {
  if (!W.active || !fb) return;
  const ref = fb.db.collection('watch').doc(W.id);
  const rec = currentRide();
  const upd = { sent: Date.now(), ...(extra || {}) };
  // while an emergency alert is up, only "I'm OK" (cloudSOSClear) may change the status
  if (store.get('sosSent', 0) && upd.status !== 'sos') { delete upd.status; delete upd.statusAt; }
  if (W.fix) upd.last = W.fix;
  if (rec) {
    const s = stats(rec);
    upd.mi = +s.mi.toFixed(2);
    upd.mph = rec.moveMs > 120000 ? +(s.mi / (rec.moveMs / 3600000)).toFixed(1) : 0;
  }
  if (W.buf.length) {
    const pts = W.buf.splice(0);
    ref.collection('pts').add({ rideKey: W.rideKey, t0: pts[0][2], p: flat(pts) }).catch(() => {});
  }
  // not awaited: with no signal Firestore keeps these on the phone and sends them later
  ref.update(upd).catch(() => {});
  W.sentAt = Date.now();
}
async function stopWatch(status) {
  if (!W.active) return;
  await flushWatch({ status, statusAt: Date.now(), ...(status === 'ended' ? { ended: Date.now() } : {}) });
  W.active = false; clearInterval(W.timer); W.timer = null;
  store.set('watchRide', null);
}
// after the app reopens mid-ride: pick the shared ride back up
function resumeWatch() {
  const key = store.get('watchRide', null), rec = currentRide();
  if (W.id && key && rec && rec.id === key && !W.active) {
    W.active = true; W.rideKey = key;
    clearInterval(W.timer); W.timer = setInterval(flushWatch, WATCH_EVERY_MS);
  }
}
// hooks from tracks.js / app.js / safety.js / plan.js
window.cloudFix = (pos) => {
  if (!W.active) return;
  const c = pos.coords;
  W.fix = { lat: +c.latitude.toFixed(5), lng: +c.longitude.toFixed(5), t: pos.timestamp || Date.now(), spd: c.speed != null && c.speed >= 0 ? +(c.speed * 2.23694).toFixed(1) : null };
};
window.cloudPoint = (p) => { if (W.active) W.buf.push([p[0], p[1], p[3]]); };
window.cloudRide = async (ev, rec) => {
  if (ev === 'start') {
    if (!W.id || !W.auto || !store.get('cloud', 0)) return;
    try { await cloud(); if (me) { await beginWatch(rec); toast('Sharing this ride live with your family link'); } } catch {}
    return;
  }
  if (!W.active) return;
  if (ev === 'paused' || ev === 'riding' || ev === 'camp' || ev === 'sos') flushWatch({ status: ev, statusAt: Date.now() });
  if (ev === 'ended') stopWatch('ended');
};
window.cloudSOS = async (lat, lng) => {
  if (!W.id) return false;
  await cloud();
  if (!me) return false;
  fb.db.collection('watch').doc(W.id).update({ status: 'sos', statusAt: Date.now(), sos: { lat: +lat.toFixed(5), lng: +lng.toFixed(5), t: Date.now() },
    last: W.fix || { lat: +lat.toFixed(5), lng: +lng.toFixed(5), t: Date.now(), spd: null }, sent: Date.now() }).catch(() => {});
  store.set('sosSent', Date.now());
  return true;
};
window.cloudSOSActive = () => !!store.get('sosSent', 0);
window.cloudSOSClear = async () => {
  if (!W.id) return;
  await cloud();
  const rec = currentRide();
  let status = rec ? (rec.paused ? 'paused' : 'riding') : 'idle';
  if (!rec) { try { const d = (await fb.db.collection('watch').doc(W.id).get()).data(); if (d && d.ended && d.ended >= (d.started || 0)) status = 'ended'; } catch {} }
  await fb.db.collection('watch').doc(W.id).update({ status, statusAt: Date.now(), sosCleared: Date.now() }).catch(() => {});
  store.set('sosSent', 0);
};
window.cloudPlanChanged = () => { if (W.active && fb) fb.db.collection('watch').doc(W.id).update({ plan: planLine() }).catch(() => {}); };
window.watchShared = () => !!W.id;

// ---------- crews ----------
const C = { code: store.get('crew', null), doc: null, ridden: new Map(), reports: [], trips: [], unsub: [], upKey: '' };
function crewHtml() {
  let h = '<h2>Crew</h2>';
  if (!C.code) {
    return h + `<p class="hint">Ride as a crew: see the trails anyone in the crew has ridden, and share trail reports (mud, washouts, downed trees). Only which trails you rode is shared, not your full tracks.</p>
      <div class="rec-row"><button class="primary" data-a="crew-create">Start a crew</button><button class="ghost" data-a="crew-join">Join with a code</button></div>`;
  }
  const d = C.doc;
  const members = d ? Object.entries(d.members || {}) : [];
  const cs = crewSummary();
  h += `<p><b>${esc(d ? d.name : 'Loading…')}</b> · code <b class="crew-code">${esc(C.code)}</b></p>
    ${cs ? `<p class="hint">Together: ${fmtMi(cs.riddenM)} of ${fmtMi(cs.totalM)} ridden (${fmtPct(pct(cs.riddenM, cs.totalM))})</p>` : ''}
    ${leaderboardHtml(members)}
    <label class="row"><input type="checkbox" id="cl-crewmap" ${shown.crew ? 'checked' : ''}> Show the crew's ridden trails on the map</label>
    ${crewTripsHtml()}
    <div class="rec-row"><button class="ghost" data-a="crew-send">Send the code</button><button class="ghost danger" data-a="crew-leave">Leave crew</button></div>`;
  return h;
}
async function createCrew() {
  const name = prompt('Crew name', `${myName()}'s crew`);
  if (!name || !name.trim()) return;
  let code;
  for (let i = 0; i < 5; i++) { code = randomId(6, CODE_CHARS); const s = await fb.db.collection('crews').doc(code).get(); if (!s.exists) break; }
  await fb.db.collection('crews').doc(code).set({ name: name.trim().slice(0, 60), owner: me.uid, members: { [me.uid]: myName() }, created: Date.now() });
  C.code = code; store.set('crew', code);
  startCrew();
  toast('Crew started. Tap "Send the code" to invite your riders.');
}
async function joinCrew() {
  const code = (prompt('Crew code') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return;
  const s = await fb.db.collection('crews').doc(code).get();
  if (!s.exists) return toast('No crew with that code. Check it and try again.');
  await fb.db.collection('crews').doc(code).update({ ['members.' + me.uid]: myName() });
  C.code = code; store.set('crew', code);
  startCrew();
  toast(`Joined ${s.data().name}`);
}
async function leaveCrew() {
  const code = C.code;
  stopCrew();
  try {
    await fb.db.collection('crews').doc(code).collection('ridden').doc(me.uid).delete();
    await fb.db.collection('crews').doc(code).update({ ['members.' + me.uid]: fb.FV.delete() });
  } catch {}
  C.code = null; store.set('crew', null); C.doc = null; C.ridden.clear(); C.reports = []; C.trips = [];
  drawCrew(); drawCrewReports(); refreshTripChip();
}
async function sendCrewCode() {
  const text = `Join my ORV crew "${C.doc ? C.doc.name : ''}" in the Michigan ORV Map app (Layers → Crew & Ride Watch → Join with a code). Code: ${C.code}  ${new URL('./', location.href).href}`;
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Code copied. Paste it in a text.'); } catch { prompt('Crew code:', C.code); }
}
async function renameEverywhere() {
  if (C.code && C.doc) await fb.db.collection('crews').doc(C.code).update({ ['members.' + me.uid]: myName() }).catch(() => {});
  if (W.id) await fb.db.collection('watch').doc(W.id).update({ name: myName() }).catch(() => {});
  C.upKey = ''; uploadRidden();
}
function stopCrew() { C.unsub.forEach((f) => f()); C.unsub = []; }
function startCrew() {
  stopCrew();
  if (!C.code || !me || !fb) return;
  const ref = fb.db.collection('crews').doc(C.code);
  C.unsub.push(ref.onSnapshot((s) => {
    C.doc = s.exists ? s.data() : null;
    if (s.exists && !(me.uid in (C.doc.members || {}))) { // removed from the crew
      stopCrew(); C.code = null; store.set('crew', null); C.doc = null; C.ridden.clear(); C.reports = []; C.trips = [];
      drawCrew(); drawCrewReports(); refreshTripChip();
    }
    refreshCloudSheet();
  }, () => {}));
  C.unsub.push(ref.collection('ridden').onSnapshot((q) => {
    C.ridden.clear();
    q.forEach((d) => C.ridden.set(d.id, d.data()));
    drawCrew(); refreshCloudSheet();
    if (window.renderGoalCard) renderGoalCard();
  }, () => {}));
  C.unsub.push(ref.collection('reports').onSnapshot((q) => {
    C.reports = [];
    q.forEach((d) => C.reports.push({ id: d.id, ...d.data() }));
    drawCrewReports();
  }, () => {}));
  C.unsub.push(ref.collection('trips').onSnapshot((q) => {
    C.trips = [];
    q.forEach((d) => C.trips.push({ id: d.id, ...d.data() }));
    C.trips.sort((a, b) => b.at - a.at);
    refreshTripChip(); refreshCloudSheet();
  }, () => {}));
  uploadRidden();
}
function refreshCloudSheet() { if (!$('#sheet').hidden && document.getElementById('cloud-view')) showCloud(); }

// my ridden trails -> the crew: { trailId: [from, to, from, to...] } (sample runs, 50 m steps)
let upT = null;
function uploadRidden() {
  clearTimeout(upT);
  upT = setTimeout(async () => {
    if (!C.code || !me || !fb || typeof progress === 'undefined' || !progress) return;
    const runs = {};
    let m = 0;
    for (const c of progress.covered) {
      const id = c.item.f.properties.id;
      if (!id) continue;
      runs[id] = flat(c.runs);
      m += c.riddenM;
    }
    // this season's totals for the crew leaderboard (totals only, never tracks)
    let season = null;
    try {
      const year = new Date().getFullYear(), y0 = new Date(year, 0, 1).getTime();
      const rides = await doneRides();
      const mine = rides.filter((t) => t.start >= y0);
      const newM = goalMilesCovered(rides) - goalMilesCovered(rides.filter((t) => t.start < y0));
      season = { y: year, mi: +mine.reduce((s, t) => s + stats(t).mi, 0).toFixed(1), rides: mine.length, newMi: +(Math.max(0, newM) / 1609.344).toFixed(1) };
    } catch {}
    const key = JSON.stringify([runs, season, myName()]);
    if (key === C.upKey) return;
    C.upKey = key;
    fb.db.collection('crews').doc(C.code).collection('ridden').doc(me.uid)
      .set({ name: myName(), runs, mi: +(m / 1609.344).toFixed(1), at: Date.now(), ...(season ? { season } : {}) }).catch(() => {});
  }, 4000);
}
window.cloudProgress = () => uploadRidden();

// the crew's ridden trails (everyone's runs merged) as a teal layer under your gold
map.createPane('crew', map.getPane('rotatePane') || map.getPane('mapPane')).style.zIndex = 415;
map.getPane('crew').style.pointerEvents = 'none';
const crewRenderer = L.canvas({ pane: 'crew' });
const crewLayer = L.layerGroup();
function crewItemsById() {
  const m = new Map();
  for (const it of prepGoal()) if (it.f.properties.id) m.set(it.f.properties.id, it);
  return m;
}
function crewCoverage() {
  // per goal item: which samples anyone in the crew (including you) has ridden
  const byId = crewItemsById(), hit = new Map();
  const add = (id, arr) => {
    const it = byId.get(id);
    if (!it) return;
    const h = hit.get(it) || new Uint8Array(it.samples.length);
    for (let i = 0; i + 1 < arr.length; i += 2) for (let k = arr[i]; k <= arr[i + 1] && k < h.length; k++) h[k] = 1;
    hit.set(it, h);
  };
  for (const [, r] of C.ridden) for (const [id, arr] of Object.entries(r.runs || {})) add(id, arr);
  for (const c of (progress && progress.covered) || []) if (c.item.f.properties.id) add(c.item.f.properties.id, flat(c.runs));
  return hit;
}
function crewSummary() {
  if (!C.code || typeof progress === 'undefined') return null;
  const hit = crewCoverage();
  let totalM = 0, riddenM = 0;
  for (const it of prepGoal()) {
    if (!fits(it.f.properties)) continue;
    totalM += it.lenM;
    const h = hit.get(it);
    if (h) riddenM += (h.reduce((s, v) => s + v, 0) / it.samples.length) * it.lenM;
  }
  return { totalM, riddenM };
}
window.crewGoalLine = () => {
  const s = C.code && C.ridden.size ? crewSummary() : null;
  return s ? `<small class="goal-bonus">Crew together: ${fmtMi(s.riddenM)} (${fmtPct(pct(s.riddenM, s.totalM))})</small>` : '';
};
function drawCrew() {
  crewLayer.clearLayers();
  if (!shown.crew || !C.code) { map.removeLayer(crewLayer); return; }
  const lines = [];
  for (const [it, h] of crewCoverage()) {
    if (!fits(it.f.properties)) continue;
    let start = -1;
    for (let i = 0; i <= h.length; i++) {
      if (i < h.length && h[i]) { if (start < 0) start = i; } else if (start >= 0) { if (i - start >= 2) lines.push(it.samples.slice(start, i)); start = -1; }
    }
  }
  if (lines.length) L.polyline(lines, { renderer: crewRenderer, color: COLORS.crew, weight: 9, opacity: 0.55, interactive: false }).addTo(crewLayer);
  crewLayer.addTo(map);
}
window.drawCrewLayer = drawCrew;
if (shown.crew === undefined) shown.crew = 1;
const crewBox = document.querySelector('[data-kind="crew"]');
if (crewBox) { crewBox.checked = !!shown.crew; crewBox.addEventListener('change', drawCrew); }

// ---------- crew leaderboard ----------
let boardSort = store.get('boardSort', 'mi');
function leaderboardHtml(members) {
  const year = new Date().getFullYear();
  const rows = members.map(([uid, n]) => {
    const r = C.ridden.get(uid) || {};
    const s = r.season && r.season.y === year ? r.season : { mi: 0, rides: 0, newMi: 0 };
    return { uid, name: n, mi: s.mi || 0, newMi: s.newMi || 0, rides: s.rides || 0, all: r.mi, shared: !!r.at };
  }).sort((a, b) => (boardSort === 'new' ? b.newMi - a.newMi || b.mi - a.mi : b.mi - a.mi || b.newMi - a.newMi));
  const medal = ['🥇', '🥈', '🥉'];
  return `<h2>${year} leaderboard</h2>
    <div class="seg board-sort"><button data-a="board-mi" class="${boardSort === 'mi' ? 'on' : ''}">Miles ridden</button><button data-a="board-new" class="${boardSort === 'new' ? 'on' : ''}">New trail</button></div>
    <ol class="board">${rows.map((r, i) => `<li class="${me && r.uid === me.uid ? 'is-me' : ''}">
      <span class="rank">${(boardSort === 'new' ? r.newMi : r.mi) > 0 && i < 3 ? medal[i] : i + 1}</span>
      <div class="who"><b>${esc(r.name)}${me && r.uid === me.uid ? ' (you)' : ''}</b>
        <small>${r.shared ? `${r.rides} ride${r.rides === 1 ? '' : 's'} this season${r.all != null ? ` · ${r.all.toFixed(0)} mi of Michigan trail all time` : ''}` : 'no rides shared yet'}</small></div>
      <div class="nums"><b>${(boardSort === 'new' ? r.newMi : r.mi).toFixed(0)}</b><small>${boardSort === 'new' ? 'new trail mi' : 'miles'}</small></div></li>`).join('')}</ol>
    <p class="hint">"New trail" is trail miles a rider covered for the first time ever this season.</p>`;
}

// ---------- planned rides shared with the crew ----------
function crewTripsHtml() {
  store.set('tripsSeen', Date.now()); // looking at the list counts as seeing new ones
  setTimeout(refreshTripChip, 0);
  if (!C.trips.length) return '<h2>Crew rides</h2><p class="hint">Plan a trip (or pick the part you\'ll ride and make it a trip), then tap "Share with my crew" on the trip.</p>';
  return '<h2>Crew rides</h2><ul class="along">' + C.trips.map((t) => `<li><b>${esc(t.name)}</b>
      <small>${t.when ? esc(t.when) + ' · ' : ''}${t.mi ? t.mi.toFixed(1) + ' mi · ' : ''}${(t.stops || []).length} stops · shared by ${esc(me && t.by === me.uid ? 'you' : t.byName || 'crew')}</small>
      ${t.note ? `<small>${esc(t.note)}</small>` : ''}
      <div class="rec-row"><button class="ghost" data-a="trip-load" data-id="${esc(t.id)}">Load this ride</button>${me && t.by === me.uid ? `<button class="ghost danger" data-a="trip-del" data-id="${esc(t.id)}">Remove</button>` : ''}</div></li>`).join('') + '</ul>';
}
window.crewCode = () => (C.code && me ? C.code : null);
window.shareTripToCrew = async () => {
  if (!C.code || !me) return toast('Join or start a crew first (Layers → Crew & Ride Watch).');
  if (typeof plan === 'undefined' || !plan || plan.stops.length < 2) return toast('Plan a trip first');
  const stops = plan.stops.map((s) => ({ lat: +(+s.lat).toFixed(6), lng: +(+s.lng).toFixed(6), name: s.mine ? 'Start' : (s.name || 'Stop'), night: !!s.night }));
  const first = stops[0].name, last = stops[stops.length - 1].name;
  const name = prompt('Name this ride for the crew', `${first} to ${last}`);
  if (name === null) return;
  const when = prompt('When? (optional, e.g. "Sat 9 AM at the Baldwin trailhead")', '') || '';
  const mi = planLegs.reduce((s, r) => s + (r.meters || 0), 0) / 1609.344;
  await fb.db.collection('crews').doc(C.code).collection('trips').add({ name: (name.trim() || 'Crew ride').slice(0, 80), when: when.trim().slice(0, 120),
    stops, mi: +mi.toFixed(1), by: me.uid, byName: myName(), at: Date.now() });
  toast('Shared with your crew');
};
async function loadCrewTrip(t) {
  if (!t) return;
  if (plan && plan.stops.length > 1 && !confirm(`Replace your planned trip with "${t.name}"?`)) return;
  plan = { stops: t.stops.map((s) => ({ lat: s.lat, lng: s.lng, name: s.name, night: !!s.night })) };
  savePlan();
  closeSheets();
  computePlan();
  toast(`Loaded "${t.name}"`);
}
// someone shared a ride you haven't seen yet
function refreshTripChip() {
  const bar = $('#crewtrip-bar');
  const seen = store.get('tripsSeen', 0);
  const fresh = C.code && me ? C.trips.filter((t) => t.by !== me.uid && t.at > seen) : [];
  bar.hidden = !fresh.length;
  if (fresh.length) bar.querySelector('span').textContent = fresh.length === 1 ? `${fresh[0].byName || 'Crew'} shared a ride: ${fresh[0].name}` : `${fresh.length} new crew rides`;
}
$('#crewtrip-bar').addEventListener('click', showCloud);

// ---------- shared trail reports ----------
const crewReportLayer = L.layerGroup().addTo(map);
function drawCrewReports() {
  crewReportLayer.clearLayers();
  if (!C.code) return;
  for (const r of C.reports) {
    if (me && r.by === me.uid) continue; // yours are already on the map from your phone
    L.marker([r.lat, r.lng], { icon: wpIcon('report', ' crew' + (Date.now() - (r.at || 0) > 30 * 86400000 ? ' old' : '')), zIndexOffset: 790 })
      .on('click', (e) => { L.DomEvent.stop(e); showCrewReport(r); })
      .addTo(crewReportLayer);
  }
}
function showCrewReport(r) {
  const label = (typeof REPORTS !== 'undefined' && REPORTS[r.r]) || r.name || 'Trail report';
  const days = Math.floor((Date.now() - (r.at || 0)) / 86400000);
  $('#sheet-body').innerHTML = `<h3>${esc(label)}</h3><span class="tag kind">Crew report</span>
    <p class="hint">Reported by ${esc(r.byName || 'a crew member')} ${days < 1 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'}.</p>
    ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
    ${(r.photos || []).length ? `<div class="photo-strip">${r.photos.map((id) => `<button class="photo-thumb" data-crew="${esc(id)}" data-cap="${esc(label)}" aria-label="Open photo"></button>`).join('')}</div>` : ''}
    <div class="rec-row"><button class="ghost" data-a="save">Save to my waypoints</button><button class="ghost" data-a="cleared">It's cleared</button></div>`;
  const crewRef = fb.db.collection('crews').doc(C.code);
  const shots = {};
  for (const b of $('#sheet-body').querySelectorAll('[data-crew]')) {
    crewRef.collection('photos').doc(b.dataset.crew).get().then((s) => {
      if (!s.exists) return b.remove();
      shots[b.dataset.crew] = s.data().d;
      b.dataset.src = s.data().d;
      b.style.backgroundImage = `url("${s.data().d}")`; b.classList.add('ready');
    }).catch(() => b.remove());
  }
  $('#sheet-body').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'save') {
      // keep a copy of the photos on this phone too
      const photos = [];
      for (const [id, d] of Object.entries(shots)) { const blob = await (await fetch(d)).blob(); await putPhoto({ id, blob, thumb: blob, at: Date.now() }); photos.push(id); }
      await tx('readwrite', (s) => s.put({ id: 'w' + Date.now(), lat: r.lat, lng: r.lng, name: label, type: 'report', r: r.r, at: r.at, note: r.note || '', photos, crewOf: r.id }), 'waypoints');
      await loadWaypoints(); closeSheets(); toast('Saved');
    }
    if (a === 'cleared') {
      for (const id of r.photos || []) crewRef.collection('photos').doc(id).delete().catch(() => {});
      await crewRef.collection('reports').doc(r.id).delete().catch(() => {});
      closeSheets(); toast('Removed for the whole crew');
    }
  };
  openSheet('#sheet');
}
// my reports -> the crew (and removing one clears it for everyone)
const CREW_PHOTO_MAX = 3;    // photos shared per report
const toDataUrl = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
window.crewReportsList = () => (C.code ? C.reports.filter((r) => !me || r.by !== me.uid) : []);
window.cloudReport = async (wp) => {
  if (!C.code || !me || !fb || wp.type !== 'report' || wp.crewOf) return;
  const crew = fb.db.collection('crews').doc(C.code);
  const ids = (wp.photos || []).slice(0, CREW_PHOTO_MAX);
  for (const id of ids) {
    try {
      const p = await getPhoto(id);
      if (!p) continue;
      const small = await shrink(p.blob, 800, 0.6); // ~60-120 KB: small enough for the free database
      crew.collection('photos').doc(id).set({ d: await toDataUrl(small), by: me.uid, at: Date.now(), rep: wp.id }).catch(() => {});
    } catch {}
  }
  crew.collection('reports').doc(wp.id).set({ lat: wp.lat, lng: wp.lng, r: wp.r || 'hazard', name: wp.name, note: wp.note || '', at: wp.at || Date.now(),
    by: me.uid, byName: myName(), photos: ids }).catch(() => {});
};
window.cloudReportGone = (wp) => {
  if (!C.code || !me || !fb || wp.type !== 'report' || wp.crewOf) return;
  const crew = fb.db.collection('crews').doc(C.code);
  for (const id of wp.photos || []) crew.collection('photos').doc(id).delete().catch(() => {});
  crew.collection('reports').doc(wp.id).delete().catch(() => {});
};

$('#btn-cloud').addEventListener('click', showCloud);
// signed in before: connect in the background so crew data and live sharing are ready
if (store.get('cloud', 0)) setTimeout(() => cloud().catch(() => {}), 2500);
