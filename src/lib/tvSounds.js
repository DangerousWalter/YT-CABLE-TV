// src/lib/tvSounds.js
//
// Classic CRT-TV sound effects, synthesized live with the Web Audio API.
// No audio files, nothing to download, nothing copyrighted.
//
//   configureSounds({ enabled, muted, volume })  keep in sync with the UI controls
//   unlockAudio()                        call from a click/key press (browser autoplay rules)
//   playChannelChange()                  relay "thunk" + a burst of static
//   playPowerOn()                        degauss thump, rising CRT whine, fading static
//   playPowerOff()                       falling "bwoop" as the picture collapses
//   startTestTone()                      the 1 kHz test-pattern beep; returns a function that stops it

const MASTER_VOLUME = 0.5; // 0..1, lower this if the effects feel too loud next to the video

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = true;
let muted = false;
let volume = 1; // 0..1, follows the volume slider

export function configureSounds(opts = {}) {
  if (opts.enabled !== undefined) enabled = Boolean(opts.enabled);
  if (opts.muted !== undefined) muted = Boolean(opts.muted);
  if (opts.volume !== undefined) {
    volume = Math.max(0, Math.min(1, Number(opts.volume) || 0));
    if (master) master.gain.value = masterLevel();
  }
}

// squared so the slider feels natural (loudness isn't linear)
const masterLevel = () => MASTER_VOLUME * volume * volume;

function getContext() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
    master = ctx.createGain();
    master.gain.value = masterLevel();
    master.connect(ctx.destination);
  }
  return ctx;
}

// For other audio modules (the jazz radio): the shared AudioContext and master volume node
export function getAudio() {
  try {
    const c = getContext();
    return c ? { ctx: c, master } : null;
  } catch {
    return null;
  }
}

export function unlockAudio() {
  try {
    const c = getContext();
    if (c && c.state === 'suspended') c.resume();
  } catch {
    /* audio unavailable: effects just stay silent */
  }
}

// One second of white noise, generated once and looped when a longer sound needs it
function getNoise(c) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// Filtered noise with a simple attack/decay envelope
function noiseBurst(c, { at, attack = 0.005, hold = 0, decay, peak, highpass = 400, lowpass = 9000 }) {
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  src.loop = true;

  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = highpass;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = lowpass;

  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.linearRampToValueAtTime(peak, at + attack);
  if (hold > 0) env.gain.setValueAtTime(peak, at + attack + hold);
  env.gain.linearRampToValueAtTime(0.0001, at + attack + hold + decay);

  src.connect(hp);
  hp.connect(lp);
  lp.connect(env);
  env.connect(master);
  src.start(at);
  src.stop(at + attack + hold + decay + 0.05);
}

// Sine blip whose pitch glides from `from` to `to`, with an exponential fade
function thump(c, { at, from, to, glide, peak, decay }) {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + glide);

  const env = c.createGain();
  env.gain.setValueAtTime(peak, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + decay);

  osc.connect(env);
  env.connect(master);
  osc.start(at);
  osc.stop(at + decay + 0.05);
}

export function playChannelChange() {
  if (!enabled || muted) return;
  try {
    const c = getContext();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;

    // relay/tuner click, then a low "thunk"
    noiseBurst(c, { at: t, attack: 0.001, decay: 0.012, peak: 0.5, highpass: 2500, lowpass: 9000 });
    thump(c, { at: t + 0.004, from: 150, to: 45, glide: 0.07, peak: 0.55, decay: 0.12 });

    // the burst of "tv static" between channels
    noiseBurst(c, { at: t + 0.02, attack: 0.01, hold: 0.16, decay: 0.2, peak: 0.32, highpass: 500, lowpass: 8000 });
  } catch (err) {
    console.warn('Could not play channel change sound:', err);
  }
}

export function playPowerOn() {
  if (!enabled || muted) return;
  try {
    const c = getContext();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;

    // degauss "thwoomp"
    thump(c, { at: t, from: 120, to: 38, glide: 0.35, peak: 0.7, decay: 0.7 });
    thump(c, { at: t, from: 240, to: 70, glide: 0.25, peak: 0.25, decay: 0.45 });

    // the CRT whine rising as the tube warms up (kept quiet; high tones are fatiguing)
    const whine = c.createOscillator();
    whine.type = 'sine';
    whine.frequency.setValueAtTime(500, t + 0.05);
    whine.frequency.exponentialRampToValueAtTime(5200, t + 0.6);
    const whineEnv = c.createGain();
    whineEnv.gain.setValueAtTime(0.0001, t + 0.05);
    whineEnv.gain.linearRampToValueAtTime(0.045, t + 0.5);
    whineEnv.gain.linearRampToValueAtTime(0.0001, t + 1.3);
    whine.connect(whineEnv);
    whineEnv.connect(master);
    whine.start(t + 0.05);
    whine.stop(t + 1.4);

    // static that fades as the picture comes up
    noiseBurst(c, { at: t + 0.05, attack: 0.05, hold: 0.25, decay: 0.8, peak: 0.28, highpass: 400, lowpass: 7000 });
  } catch (err) {
    console.warn('Could not play power-on sound:', err);
  }
}

export function playPowerOff() {
  if (!enabled || muted) return;
  try {
    const c = getContext();
    if (!c || c.state !== 'running') return;
    const t = c.currentTime;

    // the picture collapsing: a quick falling "bwoop", a static pop, then a final low thud
    thump(c, { at: t, from: 900, to: 40, glide: 0.22, peak: 0.45, decay: 0.3 });
    noiseBurst(c, { at: t, attack: 0.002, hold: 0.04, decay: 0.12, peak: 0.25, highpass: 1500, lowpass: 9000 });
    thump(c, { at: t + 0.2, from: 60, to: 35, glide: 0.1, peak: 0.35, decay: 0.2 });
  } catch (err) {
    console.warn('Could not play power-off sound:', err);
  }
}

// The classic test-pattern beep. Returns a stop() function (a no-op if sound is off).
export function startTestTone() {
  if (!enabled || muted) return () => {};
  try {
    const c = getContext();
    if (!c || c.state !== 'running') return () => {};
    const t = c.currentTime;

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1000;
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.1, t + 0.05); // kept quiet: it's a joke, not an alarm
    osc.connect(env);
    env.connect(master);
    osc.start(t);

    return () => {
      try {
        const n = c.currentTime;
        env.gain.setValueAtTime(0.1, n);
        env.gain.linearRampToValueAtTime(0.0001, n + 0.05);
        osc.stop(n + 0.08);
      } catch {
        /* already stopped */
      }
    };
  } catch (err) {
    console.warn('Could not play test tone:', err);
    return () => {};
  }
}
