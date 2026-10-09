// src/components/ProgramGuide.jsx
//
// A classic cable-guide grid: channels down the side, 30-minute time slots across the top,
// program blocks sized by their length, and a vertical "now" line showing where we are.
//
// Built to stay fast with hundreds of channels: only the rows on screen are drawn (plus a few spare),
// rows only redraw when something about them changes, and times are formatted through a shared cache.
import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { fmtTime } from '../lib/time';
import {
  SLOT_COUNT,
  SLOT_MS,
  fallbackLineup,
  fmtDuration,
  getGuideMetrics,
  getVisibleRange,
} from '../lib/guideMath';

const REFRESH_NOW_MS = 15000; // how often the "now" line moves

// ---------------------------------------------------------------------------
// One channel's row. Memoized: it only redraws when its own data, the time, or the layout changes.
// ---------------------------------------------------------------------------
const GuideRow = memo(function GuideRow({
  chan,
  idx,
  selected,
  checked,
  selectMode,
  now,
  axisStart,
  loadedAt,
  skewMs,
  labelW,
  rowH,
  slotPx,
  pxPerMin,
  axisW,
  gridBackground,
  readOnly,
  actions,
}) {
  // Built-in channels (like the test pattern) are on all the time: one block across the whole axis
  const lineup = chan.virtual
    ? [
        {
          videoId: null,
          title: chan.blurb,
          subtitle: chan.subtitle,
          startsAt: axisStart - SLOT_MS,
          endsAt: axisStart + (SLOT_COUNT + 1) * SLOT_MS,
        },
      ]
    : chan.schedule?.lineup ?? fallbackLineup(chan.schedule, loadedAt + skewMs);
  const nextIdx = lineup.findIndex((p) => p.startsAt > now);

  let rowBg = 'bg-gray-950 hover:bg-gray-900';
  if (selectMode && checked) rowBg = 'bg-red-950';
  else if (selected) rowBg = 'bg-blue-950';

  return (
    <div
      onClick={() => {
        if (!selectMode) actions.select(idx);
        else if (!chan.virtual) actions.toggle(chan.id); // built-in channels can't be selected for deletion
      }}
      className={`group flex border-b border-gray-800 cursor-pointer transition-colors ${rowBg}`}
      style={{ position: 'absolute', top: idx * rowH, left: 0, right: 0, height: rowH }}
    >
      {/* channel label (stays put while scrolling sideways) */}
      <div
        className={`sticky left-0 z-30 shrink-0 bg-inherit border-r border-gray-700 flex items-center gap-2 px-2 ${
          selected && !selectMode ? 'text-yellow-300 font-bold' : 'text-gray-200'
        }`}
        style={{ width: labelW }}
      >
        {selectMode && !chan.virtual && (
          <input
            type="checkbox"
            checked={checked}
            onClick={(e) => e.stopPropagation()}
            onChange={() => actions.toggle(chan.id)}
            className="accent-yellow-500 shrink-0"
          />
        )}
        <span className="shrink-0 text-[0.85em]">CH {chan.number}</span>
        <span className="truncate text-[1em]">{chan.name}</span>
        {chan.sources?.length > 1 && (
          <span className="shrink-0 text-[0.7em] text-yellow-300 font-normal">[{chan.sources.length}]</span>
        )}

        {!selectMode && !chan.virtual && !readOnly && (
          <div className="ml-auto flex shrink-0 opacity-0 group-hover:opacity-100 transition">
            <button
              title="Edit channel"
              onClick={(e) => {
                e.stopPropagation();
                actions.edit(chan);
              }}
              className="p-1 rounded hover:bg-black/40"
            >
              <Pencil className="w-[1em] h-[1em]" />
            </button>
            <button
              title="Delete channel"
              onClick={(e) => {
                e.stopPropagation();
                actions.remove(chan);
              }}
              className="p-1 rounded hover:bg-black/40 hover:text-red-400"
            >
              <Trash2 className="w-[1em] h-[1em]" />
            </button>
          </div>
        )}
      </div>

      {/* the programs */}
      <div className="relative shrink-0" style={{ width: axisW, backgroundImage: gridBackground }}>
        {lineup.length === 0 && <span className="absolute left-3 top-3 text-[0.85em] text-gray-500">Off Air</span>}

        {lineup.map((p, i) => {
          const left = Math.max(0, ((p.startsAt - axisStart) / 60000) * pxPerMin);
          const right = Math.min(axisW, ((p.endsAt - axisStart) / 60000) * pxPerMin);
          const width = right - left;
          if (width < 4) return null; // entirely off the axis

          const isNow = p.startsAt <= now && now < p.endsAt;
          const range = p.subtitle ?? `${fmtTime(p.startsAt)} - ${fmtTime(p.endsAt)}`;
          let extra = '';
          if (!p.subtitle && isNow) extra = ` · ${fmtDuration(p.endsAt - now)} left`;
          else if (!p.subtitle && i === nextIdx) extra = ` · in ${fmtDuration(p.startsAt - now)}`;

          return (
            <div
              key={p.startsAt}
              title={`${p.title}\n${range}${extra}`}
              className={`absolute top-1 bottom-1 rounded px-2 flex flex-col justify-center overflow-hidden border ${
                isNow ? 'bg-gray-700 border-yellow-500 text-yellow-200' : 'bg-gray-800 border-gray-700 text-gray-300'
              }`}
              style={{ left: left + 1, width: width - 2 }}
            >
              <span className="truncate text-[0.86em] font-semibold leading-tight">
                {p.startsAt < axisStart ? '◀ ' : ''}
                {p.title}
              </span>
              <span className="truncate text-[0.72em] text-gray-400 leading-tight">
                {range}
                {extra}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
export default function ProgramGuide({
  epg,
  selectedIndex,
  onSelect,
  selectMode,
  bulkSelected,
  onToggleBulk,
  onEdit,
  onDelete,
  readOnly = false, // TV mode: look, don't edit
  tv = false,
}) {
  const scrollRef = useRef(null);
  const prevAxisStart = useRef(null);
  const didInitialScroll = useRef(false);
  const [, setTick] = useState(0);

  // Measure the space we've been given, and re-measure whenever the window or layout changes size
  const [width, setWidth] = useState(0);
  const [view, setView] = useState({ top: 0, height: 0 }); // vertical scroll position and visible height
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = () => {
      setWidth(el.clientWidth);
      setView((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Track vertical scrolling (at most once per frame) so we know which rows to draw
  const frame = useRef(0);
  const handleScroll = (e) => {
    const el = e.currentTarget;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setView((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }));
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const { scale, labelW, rowH, headerH, fontPx, slotPx, pxPerMin, axisW } = getGuideMetrics(width, { tv });

  // Re-render periodically so the "now" line (and the "in 25m" labels) keep moving
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_NOW_MS);
    return () => clearInterval(t);
  }, []);

  // "Now" on the server's clock (so a TV or PC with a drifting clock still lines up)
  const skewMs = epg.skewMs || 0;
  const now = Date.now() + skewMs;
  const axisStart = Math.floor(now / SLOT_MS) * SLOT_MS;
  const nowX = ((now - axisStart) / 60000) * pxPerMin;

  // When the axis slides forward by a slot, shift the scroll with it so nothing appears to jump
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevAxisStart.current !== null && prevAxisStart.current !== axisStart) {
      const shiftPx = ((axisStart - prevAxisStart.current) / 60000) * pxPerMin;
      el.scrollLeft = Math.max(0, el.scrollLeft - shiftPx);
    }
    prevAxisStart.current = axisStart;
  }, [axisStart]);

  const scrollToNow = (smooth = true) => {
    scrollRef.current?.scrollTo({ left: Math.max(0, nowX - 40 * scale), behavior: smooth ? 'smooth' : 'auto' });
  };

  // Heads-up in the console if the server is too old to send full lineups
  const serverSendsLineup = epg.data.length === 0 || epg.data.some((c) => c.schedule?.lineup);
  useEffect(() => {
    if (!serverSendsLineup) {
      console.warn(
        'The guide data has no "lineup": restart the Node server (node server.cjs) so it picks up the new server.cjs. ' +
          'Showing the current + next two programs only.'
      );
    }
  }, [serverSendsLineup]);

  // First time there's data: bring "now" into view
  useEffect(() => {
    if (!didInitialScroll.current && epg.data.length > 0) {
      didInitialScroll.current = true;
      scrollToNow(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg.data.length]);

  // Keep the selected channel's row on screen when changing channels with the arrow keys
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = headerH + selectedIndex * rowH;
    if (top < el.scrollTop + headerH) el.scrollTop = top - headerH;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  // Stable handlers for the rows (so memoized rows aren't redrawn just because the parent was)
  const latest = useRef({});
  latest.current = { onSelect, onToggleBulk, onEdit, onDelete };
  const actions = useMemo(
    () => ({
      select: (i) => latest.current.onSelect(i),
      toggle: (id) => latest.current.onToggleBulk(id),
      edit: (c) => latest.current.onEdit(c),
      remove: (c) => latest.current.onDelete(c),
    }),
    []
  );

  const checkedIds = useMemo(() => new Set(bulkSelected), [bulkSelected]);
  const gridBackground = `repeating-linear-gradient(to right, rgba(255,255,255,0.07) 0, rgba(255,255,255,0.07) 1px, transparent 1px, transparent ${slotPx}px)`;

  const total = epg.data.length;
  const { first, last } = getVisibleRange({
    scrollTop: view.top,
    viewHeight: view.height || 600, // before the first measurement, draw a screenful
    rowH,
    headerH,
    total,
  });
  const visibleRows = [];
  for (let idx = first; idx <= last; idx++) {
    const chan = epg.data[idx];
    visibleRows.push(
      <GuideRow
        key={chan.id}
        chan={chan}
        idx={idx}
        selected={idx === selectedIndex}
        checked={checkedIds.has(chan.id)}
        selectMode={selectMode}
        now={now}
        axisStart={axisStart}
        loadedAt={epg.loadedAt}
        skewMs={skewMs}
        labelW={labelW}
        rowH={rowH}
        slotPx={slotPx}
        pxPerMin={pxPerMin}
        axisW={axisW}
        gridBackground={gridBackground}
        readOnly={readOnly}
        actions={actions}
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 min-h-0 overflow-auto relative"
      style={{ fontSize: fontPx }}
    >
      <div className="relative" style={{ width: labelW + axisW, minWidth: '100%' }}>
        {/* ---- time axis ---- */}
        <div className="sticky top-0 z-40 flex bg-gray-900 border-b border-gray-700" style={{ height: headerH }}>
          <div
            className="sticky left-0 z-50 shrink-0 bg-gray-900 flex items-center px-2 border-r border-gray-700"
            style={{ width: labelW }}
          >
            <button
              onClick={() => scrollToNow(true)}
              className="text-[0.8em] font-bold text-red-400 hover:text-red-300 tracking-wider"
              title="Scroll back to the current time"
            >
              ▶ NOW {fmtTime(now)}
            </button>
          </div>
          <div className="relative shrink-0" style={{ width: axisW }}>
            {Array.from({ length: SLOT_COUNT }, (_, i) => (
              <div
                key={i}
                className="absolute top-0 h-full border-l border-gray-700 pl-1.5 flex items-center text-[0.8em] text-gray-400 font-bold"
                style={{ left: i * slotPx }}
              >
                {fmtTime(axisStart + i * SLOT_MS)}
              </div>
            ))}
            {/* marker for "now" on the axis */}
            <div
              className="absolute bottom-0 w-0 h-0 border-l-[0.36em] border-r-[0.36em] border-b-[0.43em] border-l-transparent border-r-transparent border-b-red-500"
              style={{ left: nowX - fontPx * 0.36 }}
            />
          </div>
        </div>

        {/* ---- channel rows (only the visible ones are drawn; the container keeps the full height so scrolling works) ---- */}
        <div className="relative" style={{ height: total * rowH }}>
          {visibleRows}

          {/* the vertical "now" line */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500/90 z-20 pointer-events-none shadow-[0_0_6px_rgba(239,68,68,0.8)]"
            style={{ left: labelW + nowX - 1 }}
          />
        </div>
      </div>
    </div>
  );
}
