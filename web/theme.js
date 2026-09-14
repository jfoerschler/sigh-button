'use strict';

/*
 * Theme and accent, shared by every page.
 *
 * The viewer picks a colour; the code keeps only its hue and works out the lightness
 * itself. Hue is the part people have opinions about. Lightness is the part that decides
 * whether the rank line is readable, and handing that over would undo every contrast
 * ratio recorded in style.css: someone picks pale yellow and the text disappears.
 *
 * So for each role the lightness is searched until the WCAG ratio meets that role's
 * target against the current theme's background. Fixed lightness would not do, because
 * contrast is luminance based and two hues at the same perceived lightness can differ
 * enormously in luminance. Measuring the real ratio is correct for every hue.
 *
 * This is per viewer, in local storage. It changes nothing for anyone else.
 */

const KEY_THEME = 'sigh.theme';
const KEY_HUE = 'sigh.hue';

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private window: this session only */ }
}
function forget(key) {
  try { localStorage.removeItem(key); } catch { /* as above */ }
}

/* ------------------------------------------------------------------- colour ------- */

function channel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a, b) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
function toHex(rgb) {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
function hueOf(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null;   // a grey has no hue to keep
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/*
 * Walks lightness from the middle outward and stops at the first step that clears the
 * target. Starting at the middle means the result is the most colourful shade that is
 * still legible, rather than the safest and dullest one.
 */
function atContrast(hue, saturation, target, groundLum, goDarker) {
  for (let step = 0; step <= 100; step++) {
    const l = goDarker ? 0.5 - step / 200 : 0.5 + step / 200;
    if (l < 0 || l > 1) break;
    const rgb = hslToRgb(hue, saturation, l);
    if (ratio(luminance(rgb), groundLum) >= target) return toHex(rgb);
  }
  return null;   // unreachable for any hue at these targets, but never guess
}

/* ------------------------------------------------------------------- applying ----- */

function isDark(mode) {
  return mode
    ? mode === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyAccent(hue, dark) {
  const root = document.documentElement;
  const roles = ['--accent', '--series-people', '--face', '--face-edge'];

  if (hue === null) {
    for (const r of roles) root.style.removeProperty(r);
    return;
  }

  // The ground is whatever the stylesheet says it is for the active theme, so the search
  // is always against the real background rather than an assumed one.
  const ground = getComputedStyle(root).getPropertyValue('--ground').trim();
  const groundLum = luminance(hexToRgb(ground));
  const darker = !dark;

  //                              saturation  target  role
  const accent = atContrast(hue, 0.62, 4.5, groundLum, darker);   // carries text
  const series = atContrast(hue, 0.70, 3.0, groundLum, darker);   // carries a graphic
  /*
   * Dark mode wants the button close to the ground, not far from it, so it is set
   * directly rather than searched. A contrast floor cannot express "barely different":
   * the search satisfies any low threshold on its first step and hands back a mid tone,
   * which in dark mode is a bright button. Bright is the one thing this must not be,
   * since a glance from a passing colleague should reveal nothing.
   *
   * Light mode is the opposite case and is a real floor: the button has to read as an
   * object sitting on a pale ground.
   */
  const face = dark
    ? toHex(hslToRgb(hue, 0.20, 0.11))
    : atContrast(hue, 0.30, 8.0, groundLum, true);
  const edge = dark ? atContrast(hue, 0.16, 3.0, groundLum, false) : null;

  if (accent) root.style.setProperty('--accent', accent);
  if (series) root.style.setProperty('--series-people', series);
  if (face) root.style.setProperty('--face', face);
  root.style.setProperty('--face-edge', edge ?? 'transparent');
}

function applyAll() {
  const mode = read(KEY_THEME);
  const root = document.documentElement;
  if (mode) root.dataset.theme = mode; else delete root.dataset.theme;

  const dark = isDark(mode);
  const stored = read(KEY_HUE);
  applyAccent(stored === null ? null : Number(stored), dark);

  // Show the shade actually in use, not the one that was asked for. They differ whenever
  // the requested lightness would not have met the contrast target.
  const swatch = document.getElementById('accent');
  if (swatch) {
    const inUse = getComputedStyle(root).getPropertyValue('--accent').trim();
    if (/^#[0-9a-f]{6}$/i.test(inUse)) swatch.value = inUse;
  }

  const label = document.getElementById('theme-label');
  if (label) label.textContent = dark ? 'Light' : 'Dark';
  const toggle = document.getElementById('theme');
  if (toggle) toggle.setAttribute('aria-pressed', String(dark));
}

/* ------------------------------------------------------------------- controls ----- */

const toggle = document.getElementById('theme');
if (toggle) {
  toggle.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next = current ? (current === 'dark' ? 'light' : 'dark') : (isDark(null) ? 'light' : 'dark');
    write(KEY_THEME, next);
    applyAll();
  });
}

const picker = document.getElementById('accent');
if (picker) {
  picker.addEventListener('input', () => {
    const hue = hueOf(picker.value);
    // A grey has no hue to keep, so treat that as asking for the default back.
    if (hue === null) { forget(KEY_HUE); } else { write(KEY_HUE, String(Math.round(hue))); }
    applyAll();
  });
}

const reset = document.getElementById('accent-reset');
if (reset) {
  reset.addEventListener('click', () => {
    forget(KEY_HUE);
    applyAll();
  });
}

// Following the system means re-deriving when the system changes underneath us.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!read(KEY_THEME)) applyAll();
});

applyAll();
