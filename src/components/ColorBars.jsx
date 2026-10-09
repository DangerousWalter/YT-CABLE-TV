// src/components/ColorBars.jsx
//
// The old-school "no channel" test pattern: SMPTE-style color bars with a 1 kHz test tone.
import React, { useEffect } from 'react';
import { startTestTone } from '../lib/tvSounds';

// 75% bars, left to right
const TOP_BARS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
// the thin "castellation" strip under the bars
const MIDDLE_BARS = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
// bottom row: -I, white, +Q, black, then the PLUGE strips, then black (widths are relative)
const BOTTOM = [
  ['#00214c', 1.25],
  ['#ffffff', 1.25],
  ['#32006a', 1.25],
  ['#131313', 1.25],
  ['#090909', 0.33],
  ['#131313', 0.33],
  ['#1d1d1d', 0.33],
  ['#131313', 1],
];

export default function ColorBars({ audible, hint }) {
  // The test tone plays only while the TV is on and not muted / FX off
  useEffect(() => {
    if (!audible) return undefined;
    return startTestTone();
  }, [audible]);

  return (
    <div className="relative w-full h-full bg-black overflow-hidden select-none pointer-events-none">
      <div className="flex" style={{ height: '67%' }}>
        {TOP_BARS.map((c) => (
          <div key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex" style={{ height: '8%' }}>
        {MIDDLE_BARS.map((c, i) => (
          <div key={i} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex" style={{ height: '25%' }}>
        {BOTTOM.map(([c, w], i) => (
          <div key={i} style={{ background: c, flex: w }} />
        ))}
      </div>

      {/* faint scanlines so it looks like it's on a tube */}
      <div
        className="absolute inset-0"
        style={{ backgroundImage: 'repeating-linear-gradient(to bottom, rgba(0,0,0,0.18) 0, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)' }}
      />

      <div className="absolute left-1/2 top-[34%] -translate-x-1/2 -translate-y-1/2 bg-black/85 px-6 py-2 text-center font-mono text-white tracking-[0.3em] text-lg sm:text-2xl border border-gray-500">
        PLEASE STAND BY
      </div>

      {hint && (
        <div className="absolute left-1/2 bottom-[8%] -translate-x-1/2 bg-black/85 px-4 py-1 font-mono text-xs sm:text-sm text-gray-200 text-center">
          {hint}
        </div>
      )}
    </div>
  );
}
