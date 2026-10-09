// src/components/ChannelGuideScreen.jsx
//
// CH 0: the old cable "Channel Guide": every channel with what's on now and next, scrolling
// endlessly past while smooth jazz plays softly in the background.
import React, { memo, useEffect, useState } from 'react';
import { startJazz } from '../lib/jazzRadio';
import { fmtTime } from '../lib/time';

const ROW_H = 76; // px
const SECONDS_PER_ROW = 3.5; // scroll speed
const MAX_SCREEN_PX = 2400; // enough repeats of the list to fill a tall screen

const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

function fmtLeft(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m left`;
  const h = Math.floor(mins / 60);
  return `${h}h ${String(mins % 60).padStart(2, '0')}m left`;
}

// What's on now / next for one channel, from its lineup (falling back to the simpler schedule)
function describe(chan, now) {
  const lineup = chan.schedule?.lineup || [];
  const idx = lineup.findIndex((p) => p.startsAt <= now && now < p.endsAt);
  const cur = idx !== -1 ? lineup[idx] : null;
  const next = idx !== -1 ? lineup[idx + 1] : lineup.find((p) => p.startsAt > now);

  return {
    nowTitle: cur?.title ?? chan.schedule?.current?.title ?? 'Off Air',
    nowInfo: cur ? `${fmtTime(cur.startsAt)} - ${fmtTime(cur.endsAt)} · ${fmtLeft(cur.endsAt - now)}` : '',
    nextTitle: next?.title ?? chan.schedule?.next?.title ?? '',
    nextInfo: next ? `at ${fmtTime(next.startsAt)}` : '',
  };
}

function ChannelGuideScreen({ epg, audible, emptyHint = 'No channels yet. Use Add Channel or Import to get started.' }) {
  const [, setTick] = useState(0);

  // keep the clock and "minutes left" fresh
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // the jazz plays only while the TV is on and not muted
  useEffect(() => {
    if (!audible) return undefined;
    return startJazz();
  }, [audible]);

  const now = Date.now() + (epg.skewMs || 0);
  const rows = epg.data.map((chan) => ({ chan, ...describe(chan, now) }));
  const copies = rows.length ? Math.max(2, Math.ceil(MAX_SCREEN_PX / (rows.length * ROW_H)) + 1) : 0;

  return (
    <div className="relative w-full h-full bg-blue-950 text-white font-mono flex flex-col overflow-hidden select-none pointer-events-none">
      {/* header */}
      <div className="shrink-0 bg-blue-800 border-b-4 border-yellow-500 px-6 py-3 flex items-center justify-between gap-4">
        <div className="text-xl sm:text-3xl font-black tracking-widest text-yellow-300 truncate">CHANNEL GUIDE</div>
        <div className="text-base sm:text-2xl font-bold text-white whitespace-nowrap">
          {fmtDate(now)} &nbsp; {fmtTime(now)}
        </div>
      </div>

      {/* the endless scroll */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-blue-200 text-lg">
            {emptyHint}
          </div>
        ) : (
          <div
            className="guide-scroll absolute inset-x-0 top-0"
            style={{
              '--guide-shift': `-${rows.length * ROW_H}px`,
              animation: `guide-scroll ${rows.length * SECONDS_PER_ROW}s linear infinite`,
            }}
          >
            {Array.from({ length: copies }, (_, copy) =>
              rows.map((r, i) => (
                <div
                  key={`${copy}-${r.chan.id}`}
                  // off-screen rows cost nothing to draw: the browser skips them until they scroll into view
                  style={{ height: ROW_H, contentVisibility: 'auto', containIntrinsicSize: `auto ${ROW_H}px` }}
                  className={`flex items-center gap-4 px-6 border-b border-blue-800 ${
                    i % 2 ? 'bg-blue-900/60' : 'bg-blue-950'
                  }`}
                >
                  <div className="w-16 sm:w-24 shrink-0 text-2xl sm:text-4xl font-black text-yellow-300">{r.chan.number}</div>
                  <div className="w-40 sm:w-64 shrink-0 text-base sm:text-xl font-bold truncate">{r.chan.name}</div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-base sm:text-xl">
                      <span className="text-yellow-300 mr-2">NOW</span>
                      {r.nowTitle}
                      {r.nowInfo && <span className="text-blue-300 text-xs sm:text-sm ml-3">{r.nowInfo}</span>}
                    </div>
                    {r.nextTitle && (
                      <div className="truncate text-xs sm:text-base text-blue-200">
                        <span className="text-yellow-500 mr-2">NEXT</span>
                        {r.nextTitle}
                        {r.nextInfo && <span className="text-blue-300 text-xs ml-3">{r.nextInfo}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* soft fade at the top and bottom edges of the scroll */}
        <div
          className="absolute top-0 inset-x-0 h-12 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, var(--color-blue-950, #172554), transparent)' }}
        />
        <div
          className="absolute bottom-0 inset-x-0 h-12 pointer-events-none"
          style={{ background: 'linear-gradient(to top, var(--color-blue-950, #172554), transparent)' }}
        />
      </div>

      {/* footer tip */}
      <div className="shrink-0 bg-blue-800 border-t-4 border-yellow-500 px-6 py-2 text-xs sm:text-base text-yellow-200 text-center truncate">
        Up/Down: change channel · type a channel number to jump · G: program grid · P: power
      </div>
    </div>
  );
}

// Memoized: the rest of the app redraws often (volume display, clock, ...) and this screen doesn't need to follow
export default memo(ChannelGuideScreen);
