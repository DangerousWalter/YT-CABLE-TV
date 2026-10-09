// src/lib/guideMath.js
//
// The pure sizing and windowing maths behind the program guide (kept apart from React so it's easy to test).

export const SLOT_MIN = 30;
export const SLOT_COUNT = 8; // 4 hours on the axis
export const SLOT_MS = SLOT_MIN * 60000;

// Sizes at the base screen width. Everything grows with the screen (see getGuideMetrics).
const BASE_LABEL_W = 208; // channel column (px)
const BASE_ROW_H = 46;
const BASE_HEADER_H = 28;
const BASE_FONT_PX = 14;
const BASE_SCREEN_W = 1400; // below this the guide keeps its base size; above it, it scales up
const TV_BASE_SCREEN_W = 1000; // on a TV (seen from the couch) it scales up sooner, so text is bigger
const MAX_SCALE = 1.6;
const MIN_SLOT_PX = 120; // narrower than this and the guide scrolls sideways instead of squeezing
const MAX_SLOT_PX = 600;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The guide fills whatever width it's given: the 4-hour axis stretches to fit (bigger screen = wider time
// slots), and rows, labels and text scale up gently on big screens so they stay readable.
export function getGuideMetrics(width, { tv = false } = {}) {
  const scale = width > 0 ? clamp(width / (tv ? TV_BASE_SCREEN_W : BASE_SCREEN_W), 1, MAX_SCALE) : 1;
  const labelW = Math.round(BASE_LABEL_W * scale);
  const slotPx = clamp(Math.floor((width - labelW) / SLOT_COUNT), MIN_SLOT_PX, MAX_SLOT_PX);
  return {
    scale,
    labelW,
    rowH: Math.round(BASE_ROW_H * scale),
    headerH: Math.round(BASE_HEADER_H * scale),
    fontPx: BASE_FONT_PX * scale,
    slotPx,
    pxPerMin: slotPx / SLOT_MIN,
    axisW: slotPx * SLOT_COUNT,
  };
}

// Which rows are on screen (plus a few spare above and below). With hundreds of channels, only these get
// drawn: a 414-channel lineup is about 16,000 page elements, while the screen only ever shows a handful of rows.
export function getVisibleRange({ scrollTop, viewHeight, rowH, headerH, total, overscan = 4 }) {
  if (total <= 0) return { first: 0, last: -1 };
  const firstVisible = Math.floor((scrollTop - headerH) / rowH);
  const lastVisible = Math.ceil((scrollTop + viewHeight - headerH) / rowH) - 1;
  return {
    first: Math.max(0, firstVisible - overscan),
    last: Math.min(total - 1, lastVisible + overscan),
  };
}

export function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}

// Older servers don't send a full lineup, only current/next/upcoming. Build what we can from those
// so the guide still shows something (just 3 programs) instead of "Off Air".
export function fallbackLineup(schedule, serverLoadedAt) {
  const current = schedule?.current;
  if (!current) return [];
  const lineup = [];
  let startsAt = serverLoadedAt - (current.seekToSeconds || 0) * 1000;
  for (const prog of [current, schedule.next, schedule.upcoming]) {
    if (!prog?.durationSeconds) continue;
    lineup.push({
      videoId: prog.videoId,
      title: prog.title,
      startsAt,
      endsAt: startsAt + prog.durationSeconds * 1000,
      durationSeconds: prog.durationSeconds,
    });
    startsAt += prog.durationSeconds * 1000;
  }
  return lineup;
}
