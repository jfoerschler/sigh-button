'use strict';

/*
 * Sigh, client.
 *
 * Two things here are load bearing and easy to break by accident:
 *
 * 1. The press animation is bound to pointerdown, never to the fetch. 200ms between
 *    finger and feedback is the difference between a switch and a web form.
 * 2. The random device id never leaves this browser. What gets sent is a hash of it
 *    salted with the day and the phrase, so the server cannot link a device across days
 *    or across groups.
 */

const KEY_PHRASE = 'sigh.phrase';
const KEY_DEVICE = 'sigh.device';
const KEY_THEME = 'sigh.theme';

const el = (id) => document.getElementById(id);
const gate = el('gate');
const counter = el('counter');
const button = el('sigh');

let phrase = null;
let inFlight = false;

/* ------------------------------------------------------------------ storage ------- */

/*
 * Private windows and blocked site data make these throw rather than return null, and a
 * frustration button that crashes is a poor joke. Falling back to memory means the page
 * still works for one session.
 */
const memory = new Map();

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}

function forget(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    memory.delete(key);
  }
}

/* ------------------------------------------------------------------ identity ------ */

function deviceId() {
  let id = read(KEY_DEVICE);
  if (!id) {
    id = crypto.randomUUID();
    write(KEY_DEVICE, id);
  }
  return id;
}

function normalizePhrase(raw) {
  // Must match the Worker's normalization exactly, or two people typing the same phrase
  // with different spacing land in different rooms.
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/*
 * The privacy guarantee in one function.
 *
 * Salting by the local date breaks linkage between days: the server cannot tell that
 * Monday's third presser and Tuesday's fifth are the same browser. Salting by the phrase
 * breaks linkage between groups. Neither salt is secret, and neither needs to be: the
 * secret is the random id, which never leaves here.
 *
 * The date is the viewer's local date, which can disagree with the room's timezone near
 * midnight. That is deliberate: the alternative is asking the server which day it is
 * before every press, and the press must not wait on the network. The cost of the
 * disagreement is that one device may count as two distinct people for a few hours a
 * year, which is a better trade than a slow button.
 */
async function deviceHash() {
  const today = new Date();
  const localDay = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  return sha256Hex(`${deviceId()}:${localDay}:${normalizePhrase(phrase)}`);
}

/* ------------------------------------------------------------------ network ------- */

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('api'), { code: data.error ?? 'unavailable' });
  return data;
}

/*
 * Every message here is read by someone already having a bad day. None of them scold,
 * none of them are red, and each says what happened rather than just that it failed.
 */
function gentleMessage(code) {
  switch (code) {
    case 'rate_limited':
      return 'Still here. That one is not counted, but the day is.';
    case 'no_room':
      return 'No group has that phrase yet.';
    case 'bad_request':
      return 'Something about that did not go through.';
    default:
      return navigator.onLine
        ? 'Cannot reach the counter right now.'
        : 'You are offline. This one did not count.';
  }
}

/* ------------------------------------------------------------------ rendering ----- */

function renderToday(data) {
  const count = el('count');
  const label = el('today-label');

  if (data.suppressed) {
    count.dataset.state = 'quiet';
    count.textContent = 'Quiet So Far';
    label.textContent = 'Counts Appear Once Three People Have Pressed';
    return;
  }

  count.dataset.state = 'ready';
  count.textContent = String(data.uniques);
  label.textContent = data.uniques === 1 ? 'Person Sighed Today' : 'People Sighed Today';
}

// "America/New_York" reads as "new york"; a zone with no region part ("UTC") has no city
// to pull out, so it is shown as given rather than crashing on a missing segment.
function cityOf(timezone) {
  const parts = String(timezone ?? '').split('/');
  return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderHistory(payload) {
  const bars = el('bars');
  const note = el('history-note');
  const days = payload.days ?? [];

  bars.replaceChildren();

  const peak = days.reduce((max, day) => Math.max(max, day.uniques ?? 0), 0);
  if (peak === 0) {
    note.textContent = 'Nothing to chart yet. Days appear once three people press on them.';
    return;
  }

  for (const day of days) {
    const bar = document.createElement('span');
    const value = day.uniques ?? 0;
    bar.style.height = `${Math.max(2, Math.round((value / peak) * 100))}%`;
    const weekday = new Date(`${day.day}T12:00:00`).getDay();
    if (weekday === 0 || weekday === 6) bar.dataset.weekend = 'true';
    if (day.day === payload.today) bar.dataset.today = 'true';
    bars.append(bar);
  }

  const shown = days.filter((day) => day.shown).map((day) => day.uniques);
  const median = shown.length
    ? [...shown].sort((a, b) => a - b)[Math.floor(shown.length / 2)]
    : null;
  note.textContent = median === null
    ? 'Not enough days yet to compare against.'
    : `Typical day: ${median} ${median === 1 ? 'person' : 'people'}.`;
}

function ordinal(n) {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;   // 11th, 12th, 13th, 111th

  const lastOne = n % 10;
  if (lastOne === 1) return `${n}st`;
  if (lastOne === 2) return `${n}nd`;
  if (lastOne === 3) return `${n}rd`;
  return `${n}th`;
}

function rankMessage(data) {
  // a repeat press today: already counted, no new fact
  if (data.rank === null) {
    return null;
  }

  // first of the day
  if (data.rank === 1) {
    return `You are ${ordinal(data.rank)}, but you are not alone. The day isn't over.`;
  }

  // rank exists but the count is hidden (fewer than 3 people so far)
  if (data.suppressed) {
    return `Others are with you in this.`;
  }

  // the payoff
  return `You are the ${ordinal(data.rank)} person today. It is not just you.`;
}

/* ------------------------------------------------------------------ actions ------- */

async function loadCounter() {
  el('count').dataset.state = 'loading';
  el('count').textContent = 'Checking';
  el('today-label').textContent = 'One Moment';

  try {
    const history = await api('/api/history', { phrase, days: 90 });
    renderHistory(history);
    el('reset-note').textContent = `Resets at Midnight, ${cityOf(history.timezone)}`;

    const today = (history.days ?? []).find((day) => day.day === history.today);
    renderToday({
      suppressed: !today || !today.shown,
      uniques: today?.uniques ?? null,
      total: today?.total ?? null,
    });
    button.disabled = false;
  } catch (error) {
    if (error.code === 'no_room') {
      showGate('No group has that phrase yet. Check the spelling with whoever shared it.');
      return;
    }
    el('count').dataset.state = 'quiet';
    el('count').textContent = 'Cannot Load the Count';
    el('today-label').textContent = gentleMessage(error.code);
    // Without this the history strip is simply blank, which reads as "no one ever
    // pressed this" rather than "the chart could not load".
    el('bars').replaceChildren();
    el('history-note').textContent = 'The chart will come back when the counter does.';
    // The button stays usable: a press still feels the same and is worth allowing.
    button.disabled = false;
  }
}

async function press() {
  if (inFlight) return;
  inFlight = true;

  try {
    const data = await api('/api/push', { phrase, device_hash: await deviceHash() });
    renderToday(data);
    const message = rankMessage(data);
    el('rank').textContent = message ?? ' ';
    if (message) {
      window.setTimeout(() => { el('rank').textContent = ' '; }, 4000);
    }
    loadHistoryQuietly();
  } catch (error) {
    el('rank').textContent = gentleMessage(error.code);
  } finally {
    inFlight = false;
  }
}

async function loadHistoryQuietly() {
  try {
    renderHistory(await api('/api/history', { phrase, days: 90 }));
  } catch {
    // The chart keeping yesterday's shape is not worth a message about.
  }
}

/* ------------------------------------------------------------------ screens ------- */

function showGate(message) {
  phrase = null;
  forget(KEY_PHRASE);
  counter.hidden = true;
  gate.hidden = false;
  const error = el('gate-error');
  if (message) {
    error.textContent = message;
    error.hidden = false;
  } else {
    error.hidden = true;
  }
  el('phrase').focus();
}

function showCounter() {
  gate.hidden = true;
  counter.hidden = false;
  loadCounter();
}

/* ------------------------------------------------------------------ theme --------- */

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode) root.dataset.theme = mode; else delete root.dataset.theme;

  const dark = mode
    ? mode === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  el('theme-label').textContent = dark ? 'Light' : 'Dark';
  el('theme').setAttribute('aria-pressed', String(dark));
}

/* ------------------------------------------------------------------ wiring -------- */

/*
 * Re-setting the attribute while the animation is already running does not restart it,
 * so two quick presses would draw one ring. Clearing it and reading offsetWidth forces
 * the style flush that lets the next press animate.
 */
function ripple() {
  button.dataset.ripple = 'false';
  void button.offsetWidth;
  button.dataset.ripple = 'true';
}

const release = () => { button.dataset.pressed = 'false'; };

// Distinguishes a real pointer press from keyboard activation. Checking data-pressed
// inside the click handler cannot: pointerup has already cleared it by then, so a mouse
// press would take the keyboard path and draw a second ring.
let fromPointer = false;

button.addEventListener('pointerdown', () => {
  // Feedback first, always. Nothing here waits on the network.
  fromPointer = true;
  button.dataset.pressed = 'true';
  ripple();
  if (navigator.vibrate) navigator.vibrate(10);
});

button.addEventListener('pointerup', release);
button.addEventListener('pointercancel', release);
button.addEventListener('pointerleave', release);
button.addEventListener('animationend', () => { button.dataset.ripple = 'false'; });

// click also covers Enter and Space, which fire no pointer events at all.
button.addEventListener('click', () => {
  if (!fromPointer) {
    button.dataset.pressed = 'true';
    ripple();
    if (navigator.vibrate) navigator.vibrate(10);
    window.setTimeout(release, 120);
  }
  fromPointer = false;
  press();
});

el('gate-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const typed = el('phrase').value.trim();
  if (!typed) return;
  phrase = typed;
  write(KEY_PHRASE, typed);
  showCounter();
});

el('leave').addEventListener('click', () => {
  el('phrase').value = '';
  showGate(null);
});

el('theme').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = current ? (current === 'dark' ? 'light' : 'dark') : (systemDark ? 'light' : 'dark');
  write(KEY_THEME, next);
  applyTheme(next);
});

applyTheme(read(KEY_THEME));

phrase = read(KEY_PHRASE);
if (phrase) showCounter(); else showGate(null);
