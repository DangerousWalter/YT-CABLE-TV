// src/components/VideoPlayer.jsx
//
// A thin, caption-free wrapper around react-youtube.
// The parent gives this component a `key` that changes whenever the channel or
// program changes, so each "tune" mounts a fresh player at the right offset.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import YouTube from 'react-youtube';

// cc_load_policy=0 is only a hint; it doesn't beat a viewer's account-level
// "always show captions" setting. unloadModule forces them off.
function hideCaptions(player) {
  try {
    player.unloadModule('captions');
    player.unloadModule('cc');
  } catch {
    /* module not available yet */
  }
}

const ERROR_TEXT = {
  2: 'BAD SIGNAL',
  5: 'PLAYBACK ERROR',
  100: 'PROGRAM UNAVAILABLE',
  101: 'EMBEDDING DISABLED',
  150: 'EMBEDDING DISABLED',
};

export default function VideoPlayer({ videoId, startSeconds = 0, muted = false, volume = 100, onEnded, onError }) {
  const playerRef = useRef(null);
  const [errorCode, setErrorCode] = useState(null);

  // Read the latest `muted` at mount time without re-creating opts.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const opts = useMemo(
    () => ({
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 1,
        start: Math.floor(startSeconds),
        mute: mutedRef.current ? 1 : 0,
        cc_load_policy: 0, // no captions
        iv_load_policy: 3, // no annotations
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
      },
    }),
    [startSeconds]
  );

  // Mute toggle (the M key / button) after the player has mounted.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) p.mute();
    else p.unMute();
  }, [muted]);

  // Volume slider / Left-Right keys
  useEffect(() => {
    playerRef.current?.setVolume(volume);
  }, [volume]);

  if (!videoId) return null;

  return (
    // pointer-events-none: viewers can't pause/seek/click through to YouTube
    <div className="relative w-full h-full bg-black overflow-hidden select-none pointer-events-none">
      <YouTube
        videoId={videoId}
        opts={opts}
        className="w-full h-full"
        iframeClassName="w-full h-full border-0"
        onReady={(e) => {
          playerRef.current = e.target;
          hideCaptions(e.target);
          e.target.setVolume(volumeRef.current);
          if (mutedRef.current) e.target.mute();
          else e.target.unMute();
          e.target.playVideo();
        }}
        onStateChange={(e) => {
          // 1 = playing, 0 = ended
          if (e.data === 1) hideCaptions(e.target);
          if (e.data === 0) onEnded?.();
        }}
        onError={(e) => {
          setErrorCode(e.data);
          onError?.(e.data);
        }}
      />

      {errorCode !== null && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center font-mono text-gray-400">
          <p className="text-2xl text-red-400">{ERROR_TEXT[errorCode] || 'TECHNICAL DIFFICULTIES'}</p>
          <p className="text-sm mt-2">Please stand by...</p>
        </div>
      )}
    </div>
  );
}
