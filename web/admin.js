/*
 * Creating a group, from the browser instead of curl.
 *
 * This page is public, because a static host serves whatever path is asked for. That is
 * fine: the page is only a form. The Worker refuses a wrong code with the same 404 it
 * gives an unknown path, so it never admits the endpoint exists, and the attempt is rate
 * limited. The code is the gate; the obscure filename is not.
 *
 * The code is held in memory for the length of one submit and never written to storage or
 * a URL. Query strings end up in history, referrer headers and proxy logs.
 */

const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8787'
  : 'https://sigh-worker.holyhell.xyz';

const el = (id) => document.getElementById(id);
const form = el('room-form');
const result = el('result');
const submit = el('submit');

function say(message) {
  result.textContent = message;
  result.hidden = false;
}

function messageFor(status, code) {
  switch (code) {
    case 'room_exists':
      return 'That phrase is already taken. Pick a different one.';
    case 'bad_request':
      return 'Something about that did not go through. Check the phrase and try again.';
    default:
      // The Worker answers a wrong code and a throttled attempt identically, on purpose,
      // so this message has to cover both without saying which.
      return status === 404
        ? 'Not accepted. Check the admin code, or wait a moment if you have tried a few times.'
        : 'Cannot reach the server right now.';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const code = el('code').value.trim();
  const phrase = el('phrase').value.trim();
  if (!code || !phrase) return;

  submit.disabled = true;
  say('Creating.');

  try {
    const response = await fetch(`${API_BASE}/api/room`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${code}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        phrase,
        label: el('label').value.trim() || null,
        timezone: el('timezone').value,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      say(`Created. Share the phrase "${phrase}" with the group, and nobody else.`);
      form.reset();
    } else {
      say(messageFor(response.status, data.error));
    }
  } catch {
    say('Cannot reach the server right now.');
  } finally {
    submit.disabled = false;
  }
});
