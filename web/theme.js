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
const KEY_SAT = 'sigh.sat';

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
function saturationOf(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  return (max - min) / (1 - Math.abs(2 * l - 1));
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
 * Places a colour at a chosen lightness, then walks away from the ground only if that
 * placement fails its contrast floor.
 *
 * Placement first, floor second. An earlier version searched from mid lightness for the
 * first value clearing a floor, which meant the floor was doing the positioning: on a
 * dark ground a mid tone already clears 7:1, so roles with targets of 3 and 7 both
 * stopped at the same place and became indistinguishable. A floor says "at least this
 * legible"; it cannot say "here on the ramp".
 */
/*
 * Hue torsion: shift the hue as lightness moves away from the middle.
 *
 * Yellows and yellow-greens lose almost all their chroma when darkened, landing on olive,
 * which sits perceptually next to grey. Rotating them toward orange on the way down keeps
 * chroma alive, which is both better looking and what makes the dark step distinguishable
 * from a neutral. This is why good ramp generators do not simply dim a hue.
 */
function twist(hue, lightness) {
  const inYellowBand = hue > 30 && hue < 115;
  if (!inYellowBand) return hue;
  const darkness = Math.max(0, 0.5 - lightness) * 2;   // 0 at mid, 1 at black
  return (hue - 34 * darkness + 360) % 360;
}

function atLightness(hue, saturation, lightness, floor, groundLum) {
  /*
   * Which way contrast increases is decided by the ground, not by where the role sits.
   * Taking the direction from the placement ("further from mid") holds on a light ground
   * and is backwards on a dark one, where a role placed below mid then walks toward the
   * background instead of away, never reaches the floor, and returns null. The role then
   * falls back to the stylesheet default: still legible, so every contrast check passes,
   * but no longer part of the generated palette.
   */
  const away = groundLum > 0.18 ? -1 : 1;
  for (let step = 0; step <= 100; step++) {
    const l = lightness + (away * step) / 200;
    if (l < 0 || l > 1) break;
    const rgb = hslToRgb(twist(hue, l), saturation, l);
    // A small margin: the value is rounded to 8 bits per channel on the way to hex,
    // which can shave a hundredth off the ratio and land just under the floor.
    const hex = toHex(rgb);
    if (ratio(luminance(hexToRgb(hex)), groundLum) >= floor + 0.05) return hex;
  }
  return null;   // unreachable at these targets, but never guess
}

/* ------------------------------------------------------------------- applying ----- */

function isDark(mode) {
  return mode
    ? mode === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/* Every role the generated palette owns. Cleared together when returning to the default. */
const ROLES = [
  '--ground', '--text', '--text-soft', '--face', '--face-edge', '--face-label',
  '--accent', '--series-people', '--series-repeat',
];

/*
 * One hue generates the whole palette, background included.
 *
 * Order matters. The ground is derived first and its luminance measured, because once the
 * background is generated too, both sides of every contrast comparison move at once: a
 * palette that passes for teal can fail for yellow purely because the ground shifted.
 * Everything after it is searched against the measured value, never an assumed one.
 *
 * The extremes (ground, primary text, and the dark button) are set directly by lightness.
 * Their contrast is never in question, and the button specifically needs to stay close to
 * the ground in dark mode, which a contrast floor cannot express.
 */
function derivePalette(hue, satScale, dark) {
  const sat = (base) => Math.min(1, Math.max(0, base * satScale));
  const set = {};

  set['--ground'] = dark
    ? toHex(hslToRgb(hue, sat(0.20), 0.055))
    : toHex(hslToRgb(hue, sat(0.16), 0.965));

  const groundLum = luminance(hexToRgb(set['--ground']));

  set['--text'] = dark
    ? toHex(hslToRgb(hue, sat(0.12), 0.92))
    : toHex(hslToRgb(hue, sat(0.32), 0.09));

  set['--text-soft'] = atLightness(hue, sat(0.14), dark ? 0.68 : 0.36, 4.5, groundLum);
  set['--accent'] = atLightness(hue, sat(0.62), dark ? 0.66 : 0.34, 4.5, groundLum);

  /*
   * The two chart series must stay apart at every hue and every saturation, which hand
   * picking cannot guarantee once the palette is generated.
   *
   * Lightness does the work, because it is the axis that survives a muted pick. Chroma
   * alone collapsed: scaling saturation down turned the vivid series into a grey next to
   * a grey, and perceptual difference fell to 6.7 where 15 is the floor.
   *
   * The saturation of the people series also has a floor of its own. A muted choice may
   * mute the interface, but it must not be able to make the chart unreadable: that is
   * legibility, which is not the viewer's to trade away by accident.
   */
  const peopleSat = Math.max(0.55, sat(0.78));
  set['--series-people'] = atLightness(hue, peopleSat, dark ? 0.70 : 0.24, 3.0, groundLum);
  set['--series-repeat'] = atLightness(hue, Math.min(0.06, sat(0.06)), dark ? 0.38 : 0.56, 3.0, groundLum);

  set['--face'] = dark
    ? toHex(hslToRgb(hue, sat(0.22), 0.105))
    : atLightness(hue, sat(0.30), 0.22, 8.0, groundLum);
  set['--face-edge'] = dark ? atLightness(hue, sat(0.14), 0.55, 3.0, groundLum) : 'transparent';
  set['--face-label'] = dark
    ? toHex(hslToRgb(hue, sat(0.10), 0.93))
    : toHex(hslToRgb(hue, sat(0.18), 0.97));

  return set;
}

function applyPalette(hue, satScale, dark) {
  const root = document.documentElement;
  if (hue === null) {
    for (const role of ROLES) root.style.removeProperty(role);
    return;
  }
  const set = derivePalette(hue, satScale, dark);
  for (const [role, value] of Object.entries(set)) {
    if (value) root.style.setProperty(role, value);
  }
}

function applyAll() {
  const mode = read(KEY_THEME);
  const root = document.documentElement;
  if (mode) root.dataset.theme = mode; else delete root.dataset.theme;

  const dark = isDark(mode);
  const storedHue = read(KEY_HUE);
  const storedSat = read(KEY_SAT);
  applyPalette(
    storedHue === null ? null : Number(storedHue),
    storedSat === null ? 1 : Number(storedSat),
    dark,
  );

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
    if (hue === null) {
      forget(KEY_HUE);
      forget(KEY_SAT);
    } else {
      write(KEY_HUE, String(Math.round(hue)));
      // A muted pick gives a muted palette and a vivid one gives a vivid palette, but
      // clamped: at zero the whole interface goes grey, and above one it starts to shout.
      // Capped at 1.15 rather than 1.25: above that the ground picks up enough tint that
      // the near-neutral chart series stops separating from the vivid one, which was the
      // last two failures in the sweep. The difference is not visible; the failure was.
      write(KEY_SAT, String(Math.min(1.15, Math.max(0.45, saturationOf(picker.value) * 1.6)).toFixed(3)));
    }
    applyAll();
  });
}

const reset = document.getElementById('accent-reset');
if (reset) {
  reset.addEventListener('click', () => {
    forget(KEY_HUE);
    forget(KEY_SAT);
    applyAll();
  });
}

// Following the system means re-deriving when the system changes underneath us.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!read(KEY_THEME)) applyAll();
});

applyAll();
