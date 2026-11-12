// src/components/ArchivePlayer.jsx
//
// Plays a program that isn't on YouTube (an archive.org MP4) in a plain HTML5 <video>.
// Same props and behaviour as VideoPlayer.jsx, so App.jsx can swap one for the other:
// starts at the live offset, follows mute/volume, reports the end, and reports errors with
// the same codes the YouTube player uses (100 = can't be played at all, 2/5 = passing trouble).
//
// Two ways to play a file: straight from archive.org, or relayed through our own server (/api/media).
// Some TVs can't play archive.org's links directly, so if the direct way fails the player retries through
// the server, and this device remembers that the relay works so later programs start with it.
// Every failure (and which way finally worked) is reported to /api/diagnostics.
import React, { useEffect, useRef, useState } from 'react';

const ERROR_TEXT = {
  2: 'BAD SIGNAL',
  5: 'PLAYBACK ERROR',
  100: 'PROGRAM UNAVAILABLE',
};

// archive.org can be slow to start a big file, but if nothing plays after this long, try the other way
const STALL_MS = 30000;
const PREFER_RELAY_KEY = 'retrotv.archiveViaServer';

let preferRelay = (() => {
  try {
    return localStorage.getItem(PREFER_RELAY_KEY) === '1';
  } catch {
    return false;
  }
})();
function rememberRelay(value) {
  preferRelay = value;
  try {
    localStorage.setItem(PREFER_RELAY_KEY, value ? '1' : '0');
  } catch {
    /* private mode etc.; remembered until the app restarts */
  }
}

const relayUrl = (src) => `/api/media?src=${encodeURIComponent(src)}`;
const MEDIA_ERROR_NAMES = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'not supported' };

function report(details) {
  try {
    fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(details),
    }).catch(() => {});
  } catch {
    /* diagnostics are best-effort */
  }
}

export default function ArchivePlayer({ src, startSeconds = 0, muted = false, volume = 100, onEnded, onError }) {
  const videoRef = useRef(null);
  const [errorCode, setErrorCode] = useState(null);
  // Which ways to try, in order, for this program
  const [ways] = useState(() => (preferRelay ? ['server', 'direct'] : ['direct', 'server']));
  const [attempt, setAttempt] = useState(0);

  // Where the broadcast was when we tuned in; a retry adds the time that has passed since
  const startRef = useRef(Math.max(0, Math.floor(startSeconds)));
  const mountedAt = useRef(Date.now());

  // Latest mute/volume without restarting the video
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return undefined;

    const way = ways[attempt];
    const lastTry = attempt >= ways.length - 1;
    const start = Math.floor(startRef.current + (Date.now() - mountedAt.current) / 1000);
    const startedAt = Date.now();
    let playing = false;
    let finished = false;
    let nextTimer = null;

    const describe = (event, extra) =>
      report({
        event,
        via: way,
        video: src.split('/').pop(),
        networkState: v.networkState,
        readyState: v.readyState,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        ...extra,
      });

    // This way didn't work: try the next one, or give up and tell App.jsx
    const failWay = (code, extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(stallTimer);
      describe('error', extra);
      if (!lastTry) {
        nextTimer = setTimeout(() => setAttempt((a) => a + 1), 500);
        return;
      }
      if (code !== 100) {
        setErrorCode(code);
        onErrorRef.current?.(code);
        return;
      }
      // "Can't be played" pulls the video from every device's schedule, so only say it when the file is really
      // gone from archive.org. If it's there and just won't play on this device, treat it as passing trouble.
      fetch(relayUrl(src), { headers: { Range: 'bytes=0-0' } })
        .then((r) => (r.status === 404 ? 100 : 5))
        .catch(() => 5)
        .then((finalCode) => {
          setErrorCode(finalCode);
          onErrorRef.current?.(finalCode);
        });
    };

    const tryPlay = () => {
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          // A browser that blocks sound before a click: play muted rather than not at all
          if (err?.name === 'NotAllowedError' && !v.muted) {
            v.muted = true;
            v.play().catch(() => {});
          }
        });
      }
    };

    const handleMeta = () => {
      if (start > 0 && start < v.duration && Math.abs(v.currentTime - start) > 5) {
        try {
          v.currentTime = start;
        } catch {
          /* not seekable yet */
        }
      }
      tryPlay();
    };
    const handlePlaying = () => {
      if (playing) return;
      playing = true;
      clearTimeout(stallTimer);
      // Learn which way works on this device
      if (way === 'server' && !preferRelay) rememberRelay(true);
      if (way === 'direct' && preferRelay) rememberRelay(false);
      if (attempt > 0) describe('played', {});
    };
    const handleEnded = () => onEndedRef.current?.();
    const handleError = () => {
      const code = v.error?.code;
      // 4 = this device can't play the file at all; anything else is network/decoding trouble
      failWay(code === 4 ? 100 : 5, {
        errorCode: code ?? null,
        message: `${MEDIA_ERROR_NAMES[code] || 'unknown'}${v.error?.message ? `: ${v.error.message}` : ''}`,
      });
    };

    const stallTimer = setTimeout(() => {
      if (!playing) failWay(2, { message: `nothing played after ${STALL_MS / 1000}s` });
    }, STALL_MS);

    v.addEventListener('loadedmetadata', handleMeta);
    v.addEventListener('playing', handlePlaying);
    v.addEventListener('ended', handleEnded);
    v.addEventListener('error', handleError);

    v.muted = mutedRef.current;
    v.volume = Math.min(1, Math.max(0, volumeRef.current / 100));
    // No "#t=" time hint: some TV players reject it. We seek once the file's length is known instead.
    v.src = way === 'server' ? relayUrl(src) : src;
    v.load();

    return () => {
      clearTimeout(stallTimer);
      clearTimeout(nextTimer);
      v.removeEventListener('loadedmetadata', handleMeta);
      v.removeEventListener('playing', handlePlaying);
      v.removeEventListener('ended', handleEnded);
      v.removeEventListener('error', handleError);
      // stop downloading the old file right away
      v.removeAttribute('src');
      v.load();
    };
  }, [src, attempt, ways]);

  // Mute toggle (the M key / button)
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  // Volume slider / Left-Right keys
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = Math.min(1, Math.max(0, volume / 100));
  }, [volume]);

  if (!src) return null;

  return (
    // pointer-events-none: viewers can't pause/seek, same as the YouTube player
    <div className="relative w-full h-full bg-black overflow-hidden select-none pointer-events-none">
      <video ref={videoRef} className="w-full h-full object-contain bg-black" playsInline preload="auto" />

      {errorCode !== null && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center font-mono text-gray-400">
          <p className="text-2xl text-red-400">{ERROR_TEXT[errorCode] || 'TECHNICAL DIFFICULTIES'}</p>
          <p className="text-sm mt-2">Please stand by...</p>
        </div>
      )}
    </div>
  );
}
