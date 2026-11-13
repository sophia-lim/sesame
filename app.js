/* Sesame — the phone half.
 *
 * Talks only to the ntfy broker. It never reaches the home network directly,
 * which is why "Check now" works from the far side of town and why nothing at
 * the house needs to be exposed to the internet.
 *
 * The config (broker, topic secret, VAPID public key) arrives via a pairing
 * link's #fragment, which browsers never send to a server, and lives in
 * localStorage from then on.
 */
'use strict';

const STORE_KEY = 'sesame.config.v1';
const CACHE_KEY = 'sesame.events.v1';
const MAX_EVENTS = 60;

const S = {
  cfg: null,
  events: [],
  live: false,
  es: null,
  checking: false,
  view: 'status',
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ config */
function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
  catch { return null; }
}
function saveConfig(cfg) {
  localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
  S.cfg = cfg;
}
function topics() {
  const s = S.cfg.secret;
  return {
    leave: `sesame-leave-${s}`,
    status: `sesame-status-${s}`,
    alert: `sesame-alert-${s}`,
    register: `sesame-register-${s}`,
  };
}

/** Decode a pairing blob from a URL fragment or a pasted link. */
function parsePairing(text) {
  const m = String(text).match(/#c=([A-Za-z0-9_\-=]+)/);
  const blob = m ? m[1] : String(text).trim();
  const padded = blob.replace(/-/g, '+').replace(/_/g, '/');
  const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const cfg = JSON.parse(json);
  if (!cfg.secret || !cfg.base) throw new Error('missing fields');
  return {
    base: String(cfg.base).replace(/\/+$/, ''),
    secret: String(cfg.secret),
    vapid: cfg.vapid || '',
    stale: Number(cfg.stale) || 3600,
    user: cfg.user || '',
  };
}

/* ------------------------------------------------------------------ events */
function loadEvents() {
  try { S.events = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); }
  catch { S.events = []; }
}
function saveEvents() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(S.events.slice(-MAX_EVENTS)));
}

/** Insert an event, newest-last, de-duplicated by timestamp+state. */
function addEvent(ev) {
  if (!ev || !ev.state) return false;
  const key = `${Math.round(ev.at || 0)}|${ev.state}`;
  if (S.events.some((e) => `${Math.round(e.at || 0)}|${e.state}` === key)) return false;
  S.events.push(ev);
  S.events.sort((a, b) => (a.at || 0) - (b.at || 0));
  if (S.events.length > MAX_EVENTS) S.events = S.events.slice(-MAX_EVENTS);
  saveEvents();
  return true;
}

/** The event that decides what the hero shows: the newest settled result. */
function latest() {
  return S.events.length ? S.events[S.events.length - 1] : null;
}

/* ------------------------------------------------------------------ render */
const STATE_COPY = {
  closed: {
    eyebrow: 'CONFIRMED CLOSED', title: 'Closed',
    sub: (e) => `Confirmed ${ago(e.at)} · you're all set`,
  },
  not_closed: {
    eyebrow: 'NOT CLOSED', title: 'Not closed',
    sub: () => 'The camera saw the door and the tag was not there',
  },
  cant_check: {
    eyebrow: "CAN'T CHECK", title: "Can't check",
    sub: () => 'No picture — camera or PC may be off',
  },
  checking: {
    eyebrow: 'CHECKING', title: 'Checking…',
    sub: () => 'Grabbing a fresh frame',
  },
  offline: {
    eyebrow: 'OFFLINE', title: 'Offline',
    sub: (e) => (e && e.at ? `Last heard ${ago(e.at)}` : 'Camera or PC asleep'),
  },
  unknown: {
    eyebrow: 'NO READING YET', title: 'Unknown',
    sub: () => 'Waiting for the first check',
  },
};

/** Older versions wrote one lumped 'unconfirmed'; show those as not_closed. */
function normaliseState(s) {
  return s === 'unconfirmed' ? 'not_closed' : s;
}

function currentState() {
  const e = latest();
  if (!e) return 'unknown';
  if (e.state === 'checking') {
    // A stuck "checking" is worse than useless — it looks like progress.
    // If the PC never followed up, fall through to offline.
    return Date.now() / 1000 - e.at > 90 ? 'offline' : 'checking';
  }
  // A result older than the staleness window means the PC has gone quiet.
  // Deliberately NOT shown as "closed": an old confirmation is not a
  // current one, and this app must never imply reassurance it doesn't have.
  if (Date.now() / 1000 - e.at > (S.cfg.stale || 3600)) return 'offline';
  return normaliseState(e.state);
}

function render() {
  const state = currentState();
  const e = latest();
  const copy = STATE_COPY[state] || STATE_COPY.unknown;

  const hero = $('hero');
  hero.className = `hero state-${state}`;
  $('hero-eyebrow-text').textContent = copy.eyebrow;
  $('hero-state').textContent = copy.title;
  $('hero-sub').textContent = copy.sub(e || {});

  renderList($('activity'), S.events.slice(-4).reverse(), 'Nothing yet. Checks appear here as they happen.');
  renderList($('history'), S.events.slice().reverse(), 'No history yet.');

  $('set-live').textContent = S.live ? 'connected' : 'reconnecting…';
  $('set-live').className = 'row-value ' + (S.live ? 'good' : 'bad');
}

function renderList(el, events, emptyText) {
  if (!events.length) {
    el.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  el.innerHTML = events.map((e) => {
    const st = normaliseState(e.state);
    const label = st === 'closed' ? 'Confirmed closed'
      : st === 'not_closed' ? 'Not closed'
      : st === 'cant_check' ? "Couldn't check"
      : 'Checking…';
    const who = e.user ? cap(e.user) : 'Someone';
    const how = e.source === 'manual' ? 'checked from the app'
      : e.cached ? 'left home · reused recent check'
      : 'left home';
    return `<div class="item">
      <span class="item-icon ${esc(st)}"><i></i></span>
      <div class="item-body">
        <div class="item-title">${label}</div>
        <div class="item-sub">${esc(who)} ${esc(how)}${e.detail ? ' · ' + esc(e.detail) : ''}</div>
      </div>
      <span class="item-time">${clock(e.at)}</span>
    </div>`;
  }).join('');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function ago(ts) {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
function clock(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((today - d) / 86400000);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ ntfy */
async function backfill() {
  const { status } = topics();
  try {
    const r = await fetch(`${S.cfg.base}/${status}/json?poll=1&since=7d`);
    if (!r.ok) return;
    const text = await r.text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'message') addEvent(JSON.parse(msg.message));
      } catch { /* a message we can't parse is not worth failing over */ }
    }
    render();
  } catch (err) {
    console.warn('backfill failed', err);
  }
}

function connect() {
  const { status } = topics();
  if (S.es) S.es.close();

  const es = new EventSource(`${S.cfg.base}/${status}/sse`);
  S.es = es;

  es.onopen = () => { S.live = true; render(); };
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.event !== 'message') return;
      const ev = JSON.parse(msg.message);
      if (normaliseState(ev.state) === 'checking') {
        S.checking = true;
        setCheckingUI(true);
      } else {
        S.checking = false;
        setCheckingUI(false);
      }
      addEvent(ev);
      render();
    } catch { /* ignore malformed */ }
  };
  // EventSource reconnects on its own; we only need to reflect the gap in UI.
  es.onerror = () => { S.live = false; render(); };
}

async function trigger(source) {
  const { leave } = topics();
  const body = JSON.stringify({
    user: S.cfg.user || '',
    source: source,
  });
  const r = await fetch(`${S.cfg.base}/${leave}`, { method: 'POST', body });
  if (!r.ok) throw new Error(`ntfy returned ${r.status}`);
}

/* ------------------------------------------------------------------ push */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

async function registerPush({ silent = false } = {}) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    // On iOS, PushManager does not exist in any browser tab - Safari or
    // Chrome alike. It appears only when the page is running as a Home
    // Screen web app. "This browser cannot receive notifications" is true
    // but useless: the user is one step away, in the wrong window.
    if (!silent) {
      toast(isIOS() && !isInstalled()
        ? 'Open Sesame from its Home Screen icon and pair there \u2014 iPhones only allow notifications in the installed app, never in a browser tab.'
        : 'This browser cannot receive notifications.', 7000);
    }
    return false;
  }
  if (!S.cfg.vapid) {
    if (!silent) toast('No push key in the pairing link — re-pair from the PC.');
    return false;
  }

  // On iOS this only succeeds from a Home Screen install, and only from a
  // real tap. Both are why the setup screen is so insistent about it.
  let permission = Notification.permission;
  if (permission === 'default' && !silent) permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    if (!silent) {
      toast(isInstalled()
        ? 'Notifications were declined. Enable them in Settings › Sesame.'
        : 'Add Sesame to your Home Screen first, then try again.');
    }
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(S.cfg.vapid),
      });
    }
    const { register } = topics();
    const r = await fetch(`${S.cfg.base}/${register}`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'register',
        user: S.cfg.user || 'someone',
        subscription: sub.toJSON(),
      }),
    });
    if (!r.ok) throw new Error(`ntfy returned ${r.status}`);
    if (!silent) toast('Registered. You should get a confirmation shortly.');
    updatePushUI();
    return true;
  } catch (err) {
    console.error('push registration failed', err);
    if (!silent) toast('Could not register for notifications.');
    return false;
  }
}

function updatePushUI() {
  const supported = 'PushManager' in window;
  const granted = supported && Notification.permission === 'granted';
  $('push-nag').hidden = granted;

  // Any browser can install the app on iOS; what matters is that it is run
  // from the Home Screen icon. Pairing in a tab leaves someone with a
  // working-looking app that can never alert them, so say so plainly.
  const inBrowserTab = isIOS() && !isInstalled();
  const nag = $('push-nag');
  if (inBrowserTab) {
    nag.querySelector('div').innerHTML =
      '<b>This is a browser tab.</b><span>Add Sesame to your Home Screen and pair ' +
      'from that icon, or you will never get alerts.</span>';
    nag.querySelector('button').hidden = true;
  }

  const el = $('push-state');
  if (inBrowserTab) { el.textContent = 'needs the Home Screen app'; el.className = 'row-value bad'; }
  else if (!supported) { el.textContent = 'not supported'; el.className = 'row-value bad'; }
  else if (granted) { el.textContent = 'on'; el.className = 'row-value good'; }
  else if (Notification.permission === 'denied') {
    el.textContent = isIOS() ? 'blocked in iOS Settings' : 'blocked in browser settings';
    el.className = 'row-value bad';
  }
  else { el.textContent = 'off'; el.className = 'row-value bad'; }
}

/* ------------------------------------------------------------------ UI bits */
let toastTimer = null;
function toast(text, ms = 3800) {  // ms: longer for instructions worth reading
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setCheckingUI(on) {
  const btn = $('check-now');
  btn.disabled = on;
  $('check-now-label').textContent = on ? 'Checking…' : 'Check now';
  btn.querySelector('.check-icon').classList.toggle('spinning', on);
}

function showView(name) {
  S.view = name;
  for (const v of ['status', 'history', 'settings']) {
    $(`view-${v}`).hidden = v !== name;
  }
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === name);
  });
}

/* ------------------------------------------------------------------ setup */
function showSetup() {
  $('setup').hidden = false;
  $('app').hidden = true;
  // Only nag about installing on iOS, where it's a hard requirement.
  $('setup-install').hidden = !(isIOS() && !isInstalled());
}

function tryPair(text) {
  try {
    const cfg = parsePairing(text);
    if (!cfg.user) cfg.user = 'someone';
    saveConfig(cfg);
    history.replaceState(null, '', location.pathname + location.search);
    start();
    toast(`Paired as ${cap(cfg.user)}.`);
    // Ask for notifications right away — this is the moment the user
    // understands why, and a tap is already in flight.
    registerPush();
    return true;
  } catch (err) {
    console.warn('pairing failed', err);
    const el = $('pair-error');
    el.textContent = "That doesn't look like a Sesame pairing link. Re-run `watcher pair` on the PC and try again.";
    el.hidden = false;
    return false;
  }
}

/* ------------------------------------------------------------------ boot */
function start() {
  $('setup').hidden = true;
  $('app').hidden = false;

  $('set-base').textContent = S.cfg.base.replace(/^https?:\/\//, '');
  $('set-secret').textContent = '••••' + S.cfg.secret.slice(-4);
  $('set-user').value = S.cfg.user || '';

  loadEvents();
  render();
  updatePushUI();
  connect();
  backfill();
}

function wire() {
  $('pair-go').addEventListener('click', () => tryPair($('pair-input').value));
  $('pair-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryPair($('pair-input').value);
  });

  $('check-now').addEventListener('click', async () => {
    setCheckingUI(true);
    try {
      await trigger('manual');
      // The PC answers on the status topic; if it never does, unstick the UI.
      setTimeout(() => { if (!S.checking) setCheckingUI(false); }, 30000);
    } catch (err) {
      setCheckingUI(false);
      toast('Could not reach the broker. Are you online?');
    }
  });

  $('enable-push').addEventListener('click', () => registerPush());
  $('re-register').addEventListener('click', () => registerPush());

  $('send-test').addEventListener('click', async () => {
    try { await trigger('manual'); toast('Test check sent.'); }
    catch { toast('Could not reach the broker.'); }
  });

  $('set-user').addEventListener('change', (e) => {
    const name = e.target.value.trim() || 'someone';
    saveConfig({ ...S.cfg, user: name });
    registerPush({ silent: true });
    toast(`Alerts for this phone will say “${cap(name)}”.`);
  });

  $('reset').addEventListener('click', () => {
    if (!confirm('Unpair this phone? You will need to scan the pairing QR again.')) return;
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(CACHE_KEY);
    location.reload();
  });

  $('tab-settings-btn').addEventListener('click', () => showView('settings'));
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => showView(t.dataset.view));
  });

  // Coming back to the app should show current truth, not a stale card.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.cfg) {
      render();
      backfill();
      if (!S.live) connect();
    }
  });

  // Relative times ("2 min ago") go stale while the app sits open.
  setInterval(() => { if (S.cfg && document.visibilityState === 'visible') render(); }, 30000);
}

async function boot() {
  wire();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); }
    catch (err) { console.warn('service worker registration failed', err); }
  }

  S.cfg = loadConfig();

  if (location.hash.startsWith('#c=')) {
    if (tryPair(location.hash)) return;
  }

  if (S.cfg) start(); else showSetup();
}

boot();
