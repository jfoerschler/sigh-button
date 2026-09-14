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

/*
 * The page is served from sigh.holyhell.xyz and the API from sigh-worker.holyhell.xyz,
 * so every call is cross-origin. Development mirrors that rather than collapsing both
 * onto one port: the page runs on :8788 and the Worker on :8787, so a CORS mistake
 * fails here instead of surviving until production.
 */
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8787'
  : 'https://sigh-worker.holyhell.xyz';

const KEY_PHRASE = 'sigh.phrase';
const KEY_DEVICE = 'sigh.device';

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
  const response = await fetch(API_BASE + path, {
    method: 'POST',
    /*
     * text/plain rather than application/json, deliberately. The CORS spec treats this
     * as a simple request and skips the preflight, which would otherwise put an extra
     * round trip in front of every press. The body is still JSON; the Worker reads it as
     * text and parses it, so the header is only doing CORS work.
     */
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
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

  // Bar height is total presses; the base segment is people and the rest is repeats.
  // Stacking uniques and total directly would double count, since every press past the
  // first belongs to someone already in uniques.
  const peak = days.reduce((max, day) => Math.max(max, day.total ?? 0), 0);
  if (peak === 0) {
    bars.setAttribute('aria-label', 'No days to chart yet');
    note.textContent = 'Nothing to chart yet. Days appear once three people press on them.';
    return;
  }

  for (const day of days) {
    const total = day.total ?? 0;
    const people = day.uniques ?? 0;
    const repeats = Math.max(0, total - people);

    const bar = document.createElement('span');
    bar.className = 'day';
    const weekday = new Date(`${day.day}T12:00:00`).getDay();
    if (weekday === 0 || weekday === 6) bar.dataset.weekend = 'true';
    if (day.day === payload.today) bar.dataset.today = 'true';
    bar.title = day.shown
      ? `${day.day}: ${people} ${people === 1 ? 'person' : 'people'}, ${total} ${total === 1 ? 'press' : 'presses'}`
      : `${day.day}: too few to show`;

    // Repeats first so they sit above people in the column.
    if (repeats > 0) {
      const top = document.createElement('span');
      top.className = 'seg seg-repeat';
      top.style.height = `${Math.round((repeats / peak) * 100)}%`;
      bar.append(top);
    }
    const base = document.createElement('span');
    base.className = 'seg seg-people';
    base.style.height = `${Math.max(2, Math.round((people / peak) * 100))}%`;
    bar.append(base);

    bars.append(bar);
  }

  const shownDays = days.filter((day) => day.shown);
  const todayRow = days.find((day) => day.day === payload.today);
  bars.setAttribute(
    'aria-label',
    todayRow && todayRow.shown
      ? `Daily counts for the last 90 days. Today: ${todayRow.uniques} people, ${todayRow.total} presses.`
      : 'Daily counts for the last 90 days.',
  );

  const counts = shownDays.map((day) => day.uniques);
  const median = counts.length
    ? [...counts].sort((a, b) => a - b)[Math.floor(counts.length / 2)]
    : null;
  note.textContent = median === null
    ? 'Not enough days yet to compare against.'
    : `Typical day: ${median} ${median === 1 ? 'person' : 'people'}.`;
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

phrase = read(KEY_PHRASE);
if (phrase) showCounter(); else showGate(null);
