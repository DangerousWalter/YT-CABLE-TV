// src/lib/themes.js
//
// Per-profile color themes. Tailwind v4 reads every color from a CSS variable
// (--color-gray-900, --color-yellow-500, ...), so a theme is just a set of replacement
// values written onto <html>. Components keep using the same classes.
//
//   gray    -> surfaces (panels, rows, borders)
//   yellow  -> the accent (buttons, highlights)
//   blue    -> selection (selected channel row, current program)
//   black   -> the screen / page background
//
// "Classic" writes nothing at all, so it is exactly the original look.

export const THEME_LIST = [
  { id: 'classic', label: 'Classic', blurb: 'The original yellow-on-black cable look' },
  { id: '70s', label: "'70s", blurb: 'Harvest gold, avocado green and wood paneling' },
  { id: '80s', label: "'80s", blurb: 'Neon pink and cyan on midnight purple' },
  { id: '90s', label: "'90s", blurb: 'Teal and purple, straight out of the arcade' },
];

// Each preset is described in OKLCH (L = lightness 0-1, C = chroma, H = hue in degrees).
const PRESETS = {
  '70s': {
    gray: { H: 55, C: 0.03 },
    black: { L: 0.13, C: 0.02, H: 55 },
    accent: { L: 0.76, C: 0.15, H: 68 },
    select: { L: 0.56, C: 0.1, H: 128 },
  },
  '80s': {
    gray: { H: 300, C: 0.05 },
    black: { L: 0.11, C: 0.04, H: 295 },
    accent: { L: 0.72, C: 0.25, H: 350 },
    select: { L: 0.62, C: 0.14, H: 225 },
  },
  '90s': {
    gray: { H: 205, C: 0.035 },
    black: { L: 0.12, C: 0.025, H: 205 },
    accent: { L: 0.78, C: 0.12, H: 185 },
    select: { L: 0.55, C: 0.17, H: 310 },
  },
};

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeTheme(theme) {
  const preset = theme && (theme.preset === 'classic' || PRESETS[theme.preset]) ? theme.preset : 'classic';
  const accent = theme && HEX_RE.test(theme.accent || '') ? theme.accent.toLowerCase() : null;
  return { preset, accent };
}

// ---------- color math: OKLCH <-> sRGB hex ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklchToLinearRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.0001 && v <= 1.0001);

export function oklchToHex(L, C, H) {
  let chroma = C;
  let rgb = oklchToLinearRgb(L, chroma, H);
  // if the color is too vivid for a screen, pull the chroma in until it fits
  for (let i = 0; i < 30 && !inGamut(rgb); i++) {
    chroma *= 0.92;
    rgb = oklchToLinearRgb(L, chroma, H);
  }
  return (
    '#' +
    rgb
      .map((v) => Math.round(toGamma(clamp(v, 0, 1)) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

export function hexToOklch(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), H: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

// ---------- ramps ----------
const GRAY_L = { 50: 0.985, 100: 0.967, 200: 0.928, 300: 0.872, 400: 0.707, 500: 0.551, 600: 0.446, 700: 0.373, 800: 0.278, 900: 0.21, 950: 0.13 };
const GRAY_C = { 50: 0.2, 100: 0.25, 200: 0.3, 300: 0.4, 400: 0.6, 500: 0.8, 600: 0.9, 700: 1, 800: 1, 900: 1, 950: 1 };

function grayRamp({ H, C }) {
  const ramp = {};
  for (const s of SHADES) ramp[s] = oklchToHex(GRAY_L[s], C * GRAY_C[s], H);
  return ramp;
}

// A full 50-950 ramp around a single "500" color
const LIGHT_L = { 50: 0.975, 100: 0.955, 200: 0.925, 300: 0.885 };
const DARK_F = { 600: 0.86, 700: 0.7, 800: 0.6, 900: 0.52, 950: 0.37 };
const RAMP_C = { 50: 0.12, 100: 0.22, 200: 0.4, 300: 0.62, 400: 0.85, 500: 1, 600: 0.95, 700: 0.8, 800: 0.65, 900: 0.5, 950: 0.35 };

function colorRamp({ L, C, H }) {
  const ramp = {};
  for (const s of SHADES) {
    let l;
    if (s < 400) l = LIGHT_L[s];
    else if (s === 400) l = L + (LIGHT_L[300] - L) * 0.4;
    else if (s === 500) l = L;
    else l = Math.max(0.18, L * DARK_F[s]);
    ramp[s] = oklchToHex(l, C * RAMP_C[s], H);
  }
  return ramp;
}

// The accent button text is black, so keep the accent light enough to read it
function accentFromHex(hex) {
  const { L, C, H } = hexToOklch(hex);
  return { L: clamp(L, 0.62, 0.84), C, H };
}

// Theme -> { '--color-gray-900': '#...', ... }. Classic (and no custom accent) gives {}.
export function buildPalette(theme) {
  const { preset, accent } = normalizeTheme(theme);
  const def = PRESETS[preset];
  const vars = {};

  if (def) {
    for (const [s, hex] of Object.entries(grayRamp(def.gray))) vars[`--color-gray-${s}`] = hex;
    vars['--color-black'] = oklchToHex(def.black.L, def.black.C, def.black.H);
    for (const [s, hex] of Object.entries(colorRamp(def.select))) vars[`--color-blue-${s}`] = hex;
  }

  const accentBase = accent ? accentFromHex(accent) : def?.accent;
  if (accentBase) {
    for (const [s, hex] of Object.entries(colorRamp(accentBase))) vars[`--color-yellow-${s}`] = hex;
  }
  return vars;
}

// Four colors for the preview cards
const CLASSIC_SWATCH = { bg: '#000000', surface: '#101828', accent: '#f0b100', select: '#1447e6' };

export function getSwatches(theme) {
  const v = buildPalette(theme);
  return {
    bg: v['--color-black'] ?? CLASSIC_SWATCH.bg,
    surface: v['--color-gray-900'] ?? CLASSIC_SWATCH.surface,
    accent: v['--color-yellow-500'] ?? CLASSIC_SWATCH.accent,
    select: v['--color-blue-700'] ?? CLASSIC_SWATCH.select,
  };
}

// ---------- apply to the page ----------
let appliedNames = [];

export function applyTheme(theme) {
  const root = document.documentElement;
  const t = normalizeTheme(theme);
  for (const name of appliedNames) root.style.removeProperty(name);

  const vars = buildPalette(t);
  appliedNames = Object.keys(vars);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset.theme = t.preset;
}
