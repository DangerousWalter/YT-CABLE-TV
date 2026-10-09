// src/components/StaticOverlay.jsx
//
// A brief burst of TV snow drawn over the picture whenever `trigger` changes.
// The noise is drawn at near-HD resolution with soft edges, a little horizontal banding
// and scanlines, so it looks like fine analog snow rather than big blocks.
// Skipped entirely for people who've asked their system to reduce motion.
import React, { useEffect, useRef, useState } from 'react';

// Resolution of the noise. Higher = finer grain (and a little more work per frame).
const NOISE_W = 960;
const NOISE_H = 540;
const FRAME_MS = 45; // ~22 new frames of noise per second

export default function StaticOverlay({ trigger, duration = 450 }) {
  const canvasRef = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!trigger) return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return undefined;

    const image = ctx.createImageData(NOISE_W, NOISE_H);
    const pixels = new Uint32Array(image.data.buffer); // one write per pixel instead of four
    const start = performance.now();
    let lastDraw = 0;
    let raf;

    setVisible(true);
    const draw = (now) => {
      if (now - lastDraw > FRAME_MS) {
        lastDraw = now;
        for (let y = 0; y < NOISE_H; y++) {
          // each line gets its own slight brightness drift: the horizontal banding of real snow
          const bias = (Math.random() - 0.5) * 60;
          const row = y * NOISE_W;
          for (let x = 0; x < NOISE_W; x++) {
            let v = (Math.random() * 255 + bias) | 0;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            pixels[row + x] = 0xff000000 | (v << 16) | (v << 8) | v; // opaque gray (R = G = B = v)
          }
        }
        ctx.putImageData(image, 0, 0);
      }
      if (now - start < duration) raf = requestAnimationFrame(draw);
      else setVisible(false);
    };
    raf = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(raf);
  }, [trigger, duration]);

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none z-20 transition-opacity duration-200"
      style={{ opacity: visible ? 0.8 : 0 }}
    >
      <canvas ref={canvasRef} width={NOISE_W} height={NOISE_H} className="absolute inset-0 w-full h-full" />
      {/* scanlines over the snow */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: 'repeating-linear-gradient(to bottom, rgba(0,0,0,0.28) 0, rgba(0,0,0,0.28) 1px, transparent 1px, transparent 3px)',
        }}
      />
    </div>
  );
}
