// src/lib/jazzRadio.js
//
// An endless, gentle "smooth jazz" generated live with the Web Audio API: electric piano chords,
// a soft bass, brushed drums and a lazy saxophone-ish lead. Nothing is recorded or downloaded
// (so there are no licensing worries), and it never repeats exactly: the chord loop is picked at
// random and the lead line is improvised bar by bar.
//
// The music is planned by pure functions (planBar, buildCycle) and then played by small
// instrument functions, which keeps the "composing" part easy to test.

import { getAudio } from './tvSounds';

const BPM = 76;
const BEAT = 60 / BPM;
const SWING = 2 / 3; // the "and" of a beat lands two thirds of the way through it (triplet swing)
const JAZZ_LEVEL = 0.6; // overall level of the music (the volume slider still scales it)

export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

// bass = root note, voicing = rootless chord shape for the piano, scale = pitch classes the lead may use
export const CHORDS = {
  Dm9: { bass: 38, voicing: [53, 57, 60, 64], scale: [2, 4, 5, 7, 9, 11, 0] },
  G13: { bass: 43, voicing: [59, 64, 65, 69], scale: [7, 9, 11, 0, 2, 4, 5] },
  Cmaj9: { bass: 48, voicing: [52, 55, 59, 62], scale: [0, 2, 4, 7, 9, 11] },
  A13: { bass: 45, voicing: [55, 61, 64, 66], scale: [9, 11, 1, 2, 4, 6, 7] },
  Fmaj9: { bass: 41, voicing: [57, 60, 64, 67], scale: [5, 7, 9, 11, 0, 2, 4] },
  Em9: { bass: 40, voicing: [55, 59, 62, 66], scale: [4, 6, 7, 9, 11, 0, 2] },
  Am9: { bass: 45, voicing: [60, 64, 67, 71], scale: [9, 11, 0, 2, 4, 5, 7] },
};

// Eight-bar loops (ii-V-I-VI and friends)
const PROGRESSIONS = [
  ['Dm9', 'G13', 'Cmaj9', 'A13', 'Dm9', 'G13', 'Cmaj9', 'Cmaj9'],
  ['Cmaj9', 'Am9', 'Dm9', 'G13', 'Em9', 'A13', 'Dm9', 'G13'],
  ['Fmaj9', 'Em9', 'Dm9', 'G13', 'Cmaj9', 'Am9', 'Dm9', 'G13'],
];

export function buildCycle(rng = Math.random) {
  return PROGRESSIONS[Math.floor(rng() * PROGRESSIONS.length)].map((name) => ({ name, ...CHORDS[name] }));
}

const LEAD_LOW = 69; // A4
const LEAD_HIGH = 84; // C6

// One bar (four beats) of music as a list of events. `t` and `dur` are in beats from the start of the bar.
export function planBar({ chord, rng = Math.random, lastLead = 74 }) {
  const events = [];

  // bass: root on 1, then the fifth or octave on 3
  events.push({ inst: 'bass', t: 0, dur: 1.8, midi: chord.bass, vel: 0.9 });
  events.push({ inst: 'bass', t: 2, dur: 1.6, midi: chord.bass + (rng() < 0.5 ? 7 : 12), vel: 0.7 });

  // electric piano: a long chord on 1, with light syncopated stabs
  events.push({ inst: 'ep', t: 0, dur: 2.4, midis: chord.voicing, vel: 0.8 });
  if (rng() < 0.65) events.push({ inst: 'ep', t: 1 + SWING, dur: 0.7, midis: chord.voicing, vel: 0.5 });
  if (rng() < 0.3) events.push({ inst: 'ep', t: 3 + SWING, dur: 0.5, midis: chord.voicing, vel: 0.4 });

  // brushes: the classic "ding, ding-a-ding" swing pattern, feathered kick, soft backbeat swish
  for (const t of [0, 1, 2, 3]) events.push({ inst: 'hat', t, vel: 0.45 });
  for (const t of [1 + SWING, 3 + SWING]) if (rng() < 0.9) events.push({ inst: 'hat', t, vel: 0.3 });
  for (const t of [1, 3]) if (rng() < 0.8) events.push({ inst: 'snare', t, vel: 0.28 });
  if (rng() < 0.6) events.push({ inst: 'kick', t: 0, vel: 0.35 });
  if (rng() < 0.3) events.push({ inst: 'kick', t: 2, vel: 0.3 });

  // lead: sometimes silent, otherwise one to three lazy notes drifting through the chord's scale
  const pool = [];
  for (let m = LEAD_LOW; m <= LEAD_HIGH; m++) if (chord.scale.includes(m % 12)) pool.push(m);

  const r = rng();
  const count = r < 0.25 ? 0 : r < 0.6 ? 1 : r < 0.9 ? 2 : 3;
  const slots = [0, SWING, 1, 1 + SWING, 2, 2 + SWING, 3];
  const starts = [];
  while (starts.length < count) {
    const s = slots[Math.floor(rng() * slots.length)];
    if (!starts.includes(s)) starts.push(s);
  }
  starts.sort((a, b) => a - b);

  let idx = pool.reduce((best, m, i) => (Math.abs(m - lastLead) < Math.abs(pool[best] - lastLead) ? i : best), 0);
  let last = lastLead;
  starts.forEach((t, i) => {
    const step = Math.floor(rng() * 7) - 3; // -3..+3 scale steps
    idx = Math.min(pool.length - 1, Math.max(0, idx + step));
    const nextStart = i + 1 < starts.length ? starts[i + 1] : 4.5;
    const dur = Math.max(0.5, Math.min(nextStart - t, 1.6) * 0.92);
    last = pool[idx];
    events.push({ inst: 'lead', t, dur, midi: last, vel: 0.5 + rng() * 0.25 });
  });

  return { events, lastLead: last };
}

// ---------------------------------------------------------------------------------------------
// Instruments (each schedules a few Web Audio nodes at an exact time)
// ---------------------------------------------------------------------------------------------

function makeNoise(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function makeReverbImpulse(ctx, seconds = 1.8) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  return buffer;
}

// Electric piano: a sine carrier whose pitch is wobbled by a decaying modulator gives the tine "bell"
function playEp(ctx, out, send, time, midi, dur, vel) {
  const f = midiToFreq(midi);
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = f;
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(f * 1.4 * vel, time);
  modGain.gain.exponentialRampToValueAtTime(f * 0.05, time + 0.5);
  mod.connect(modGain);
  modGain.connect(carrier.frequency);

  const ring = Math.min(dur + 0.9, 2.6);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, time);
  env.gain.linearRampToValueAtTime(0.07 * vel, time + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, time + ring);
  carrier.connect(env);
  env.connect(out);
  env.connect(send);

  carrier.start(time);
  mod.start(time);
  carrier.stop(time + ring + 0.05);
  mod.stop(time + ring + 0.05);
}

function playBass(ctx, out, time, midi, dur, vel) {
  const f = midiToFreq(midi);
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.value = f;
  const edge = ctx.createOscillator();
  edge.type = 'triangle';
  edge.frequency.value = f;
  const edgeGain = ctx.createGain();
  edgeGain.gain.value = 0.35;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 520;

  const end = time + dur + 0.2;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, time);
  env.gain.linearRampToValueAtTime(0.2 * vel, time + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, end);

  body.connect(lp);
  edge.connect(edgeGain);
  edgeGain.connect(lp);
  lp.connect(env);
  env.connect(out);
  body.start(time);
  edge.start(time);
  body.stop(end + 0.05);
  edge.stop(end + 0.05);
}

function playNoiseHit(ctx, out, noise, time, { type, freq, q = 0.7, attack, decay, peak }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, time);
  env.gain.linearRampToValueAtTime(peak, time + attack);
  env.gain.linearRampToValueAtTime(0.0001, time + attack + decay);
  src.connect(filter);
  filter.connect(env);
  env.connect(out);
  src.start(time);
  src.stop(time + attack + decay + 0.05);
}

function playKick(ctx, out, time, vel) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(90, time);
  osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.14 * vel, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + 0.22);
  osc.connect(env);
  env.connect(out);
  osc.start(time);
  osc.stop(time + 0.25);
}

// Lead: a sawtooth softened by a low-pass filter, with a slow vibrato that fades in, like a mellow sax
function playLead(ctx, out, send, time, midi, dur, vel) {
  const f = midiToFreq(midi);
  const saw = ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.value = f;

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 5.2;
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(0.0001, time);
  lfoGain.gain.linearRampToValueAtTime(f * 0.008, time + Math.min(dur, 0.6));
  lfo.connect(lfoGain);
  lfoGain.connect(saw.frequency);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1700;
  lp.Q.value = 0.8;

  const end = time + dur + 0.18;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, time);
  env.gain.linearRampToValueAtTime(0.045 * vel, time + 0.07);
  env.gain.setValueAtTime(0.045 * vel, time + dur);
  env.gain.linearRampToValueAtTime(0.0001, end);

  saw.connect(lp);
  lp.connect(env);
  env.connect(out);
  env.connect(send);
  saw.start(time);
  lfo.start(time);
  saw.stop(end + 0.05);
  lfo.stop(end + 0.05);
}

// ---------------------------------------------------------------------------------------------

// Starts the music. Returns a function that fades it out and stops it.
export function startJazz(rng = Math.random) {
  const audio = getAudio();
  if (!audio || audio.ctx.state !== 'running') return () => {};
  const { ctx, master } = audio;

  try {
    const t0 = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t0);
    bus.gain.linearRampToValueAtTime(JAZZ_LEVEL, t0 + 1.5); // fade in gently
    bus.connect(master);

    // a touch of room: send -> reverb -> bus
    const send = ctx.createGain();
    send.gain.value = 0.35;
    const reverb = ctx.createConvolver();
    reverb.buffer = makeReverbImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    send.connect(reverb);
    reverb.connect(wet);
    wet.connect(bus);

    const noise = makeNoise(ctx);

    let cycle = buildCycle(rng);
    let barNumber = 0;
    let barTime = t0 + 0.2;
    let lastLead = 74;

    const playBar = () => {
      const chord = cycle[barNumber % cycle.length];
      const plan = planBar({ chord, rng, lastLead });
      lastLead = plan.lastLead;

      for (const e of plan.events) {
        const at = barTime + e.t * BEAT;
        const dur = (e.dur || 0) * BEAT;
        switch (e.inst) {
          case 'bass':
            playBass(ctx, bus, at, e.midi, dur, e.vel);
            break;
          case 'ep':
            e.midis.forEach((m, i) => playEp(ctx, bus, send, at + i * 0.018, m, dur, e.vel)); // slightly rolled chord
            break;
          case 'hat':
            playNoiseHit(ctx, bus, noise, at, { type: 'highpass', freq: 6500, attack: 0.004, decay: 0.05, peak: 0.07 * e.vel });
            break;
          case 'snare':
            playNoiseHit(ctx, bus, noise, at, { type: 'bandpass', freq: 2200, attack: 0.02, decay: 0.16, peak: 0.12 * e.vel });
            break;
          case 'kick':
            playKick(ctx, bus, at, e.vel);
            break;
          case 'lead':
            playLead(ctx, bus, send, at, e.midi, dur, e.vel);
            break;
          default:
            break;
        }
      }

      barNumber += 1;
      barTime += 4 * BEAT;
      if (barNumber % cycle.length === 0) cycle = buildCycle(rng); // new loop, possibly a new progression
    };

    // keep about 1.5 seconds of music scheduled ahead of the clock
    const tick = () => {
      while (barTime < ctx.currentTime + 1.5) playBar();
    };
    tick();
    const timer = setInterval(tick, 250);

    return () => {
      clearInterval(timer);
      try {
        const n = ctx.currentTime;
        bus.gain.cancelScheduledValues(n);
        bus.gain.setValueAtTime(bus.gain.value, n);
        bus.gain.linearRampToValueAtTime(0.0001, n + 0.4);
        setTimeout(() => bus.disconnect(), 600);
      } catch {
        /* already gone */
      }
    };
  } catch (err) {
    console.warn('Could not start the jazz:', err);
    return () => {};
  }
}
