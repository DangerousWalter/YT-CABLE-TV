// src/components/ArchivePlayer.jsx
//
// Plays a program that isn't on YouTube (an archive.org MP4) in a plain HTML5 <video>.
// Same props and behaviour as VideoPlayer.jsx, so App.jsx can swap one for the other:
// starts at the live offset, follows mute/volume, reports the end, and reports errors with
// the same codes the YouTube player uses (100 = can't be played at all, 2/5 = passing trouble).
import React, { useEffect, useRef, useState } from 'react';

const ERROR_TEXT = {
  2: 'BAD SIGNAL',
  5: 'PLAYBACK ERROR',
  100: 'PROGRAM UNAVAILABLE',
};

// archive.org can be slow to start a big file, but if nothing plays after this long, give up on it for now
const STALL_MS = 45000;

export default function ArchivePlayer({ src, startSeconds = 0, muted = false, volume = 100, onEnded, onError }) {
  const videoRef = useRef(null);
  const [errorCode, setErrorCode] = useState(null);
  const [attempt, setAttempt] = useState(0); // one quiet retry before calling a file unplayable

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

    const start = Math.floor(startRef.current + (Date.now() - mountedAt.current) / 1000);
    let playing = false;
    let finished = false;
    let retryTimer = null;

    const fail = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(stallTimer);
      setErrorCode(code);
      onErrorRef.current?.(code);
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
      // The #t= hint usually lands us there already; seek if it didn't
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
      playing = true;
      clearTimeout(stallTimer);
    };
    const handleEnded = () => onEndedRef.current?.();
    const handleError = () => {
      if (finished) return;
      // 4 = the file is missing or in a format this device can't play; anything else is a network hiccup
      if (v.error?.code === 4) {
        if (attempt === 0) retryTimer = setTimeout(() => setAttempt(1), 3000);
        else fail(100);
      } else {
        fail(5);
      }
    };

    const stallTimer = setTimeout(() => {
      if (!playing) fail(2);
    }, STALL_MS);

    v.addEventListener('loadedmetadata', handleMeta);
    v.addEventListener('playing', handlePlaying);
    v.addEventListener('ended', handleEnded);
    v.addEventListener('error', handleError);

    v.muted = mutedRef.current;
    v.volume = Math.min(1, Math.max(0, volumeRef.current / 100));
    v.src = `${src}#t=${start}`;

    return () => {
      clearTimeout(stallTimer);
      clearTimeout(retryTimer);
      v.removeEventListener('loadedmetadata', handleMeta);
      v.removeEventListener('playing', handlePlaying);
      v.removeEventListener('ended', handleEnded);
      v.removeEventListener('error', handleError);
      // stop downloading the old file right away
      v.removeAttribute('src');
      v.load();
    };
  }, [src, attempt]);

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
