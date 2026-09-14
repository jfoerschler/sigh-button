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
      return 'still here. that one is not counted, but the day is.';
    case 'no_room':
      return 'no group has that phrase yet.';
    case 'bad_request':
      return 'something about that did not go through.';
    default:
      return navigator.onLine
        ? 'cannot reach the counter right now.'
        : 'you are offline. this one did not count.';
  }
}

/* ------------------------------------------------------------------ rendering ----- */

function renderToday(data) {
  const count = el('count');
  const label = el('today-label');

  if (data.suppressed) {
    count.dataset.state = 'quiet';
    count.textContent = 'quiet so far';
    label.textContent = 'counts appear once three people have pressed';
    return;
  }

  count.dataset.state = 'ready';
  count.textContent = String(data.uniques);
  label.textContent = data.uniques === 1 ? 'person sighed today' : 'people sighed today';
}

// "America/New_York" reads as "new york"; a zone with no region part ("UTC") has no city
// to pull out, so it is shown as given rather than crashing on a missing segment.
function cityOf(timezone) {
  const parts = String(timezone ?? '').split('/');
  return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).replace(/_/g, ' ').toLowerCase();
}

function renderHistory(payload) {
  const bars = el('bars');
  const note = el('history-note');
  const days = payload.days ?? [];

  bars.replaceChildren();

  const peak = days.reduce((max, day) => Math.max(max, day.uniques ?? 0), 0);
  if (peak === 0) {
    note.textContent = 'nothing to chart yet. days appear once three people press on them.';
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
    ? 'not enough days yet to compare against.'
    : `typical day: ${median} ${median === 1 ? 'person' : 'people'}.`;
}

// TODO(human): implement rankMessage(data)
//
// Turn a successful /api/push response into the line shown under the button, or null to
// leave it blank. This is the emotional payload of the whole app, which is why it is
// yours rather than mine.
//
// `data` looks like:
//   { suppressed: boolean, uniques: number|null, total: number|null,
//     rank: number|null, day: '2026-09-14', timezone: 'America/New_York' }
//
// The cases that matter:
//   - rank === 1        being told you are "the 1st" reads lonely, which inverts the
//                       point of the app. Use "first sigh today. it's early."
//   - rank > 1          the payoff: this person is not alone. ordinals need care (2nd,
//                       3rd, 11th, 21st).
//   - rank === null     a repeat press today. already counted in uniques, so there is no
//                       new fact and nothing to reward. the press should still have felt
//                       good; consider returning null, or something that acknowledges
//                       without pretending it was data.
//   - data.suppressed   fewer than three people so far, so uniques and total are null and
//                       rank may still be a number. decide whether a rank without a
//                       visible count is reassuring or confusing.
function rankMessage(data) {
  return null;
}

/* ------------------------------------------------------------------ actions ------- */

async function loadCounter() {
  el('count').dataset.state = 'loading';
  el('count').textContent = 'checking';
  el('today-label').textContent = 'one moment';

  try {
    const history = await api('/api/history', { phrase, days: 90 });
    renderHistory(history);
    el('reset-note').textContent = `resets at midnight, ${cityOf(history.timezone)}`;

    const today = (history.days ?? []).find((day) => day.day === history.today);
    renderToday({
      suppressed: !today || !today.shown,
      uniques: today?.uniques ?? null,
      total: today?.total ?? null,
    });
    button.disabled = false;
  } catch (error) {
    if (error.code === 'no_room') {
      showGate('no group has that phrase yet. check the spelling with whoever shared it.');
      return;
    }
    el('count').dataset.state = 'quiet';
    el('count').textContent = 'cannot load the count';
    el('today-label').textContent = gentleMessage(error.code);
    // Without this the history strip is simply blank, which reads as "no one ever
    // pressed this" rather than "the chart could not load".
    el('bars').replaceChildren();
    el('history-note').textContent = 'the chart will come back when the counter does.';
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
  el('theme-label').textContent = dark ? 'light' : 'dark';
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
