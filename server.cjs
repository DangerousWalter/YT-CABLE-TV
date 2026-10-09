const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

// Where this install keeps its files (database, settings). The desktop app points RETROTV_DATA_DIR at the
// per-user app-data folder; running from the project folder keeps everything right here, as before.
const DATA_DIR = process.env.RETROTV_DATA_DIR || __dirname;
// A .env in the project folder is for `npm run server` / `npm run dev`. The desktop app, like an installed one, only
// uses its own data folder (so testing it with `npm run desktop` behaves like the real thing, including the first-run welcome).
if (!process.versions.electron) require('dotenv').config();
require('dotenv').config({ path: path.join(DATA_DIR, '.env') }); // or in the data folder (never overrides)

const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./server/db.cjs');

const app = express();

// ==========================================
// SETTINGS (YouTube API key, network access), saved in the data folder
// ==========================================
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = { youtubeApiKey: '', lanAccess: false };
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {
  /* first run: no settings yet */
}
if (settings.youtubeApiKey) process.env.YOUTUBE_API_KEY = settings.youtubeApiKey; // a key saved in Settings wins over .env

function saveSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 }); // only this user can read it
}

const lanEnabled = () => Boolean(settings.lanAccess) || process.env.RETROTV_LAN === '1';
const NO_KEY_MESSAGE = 'No YouTube API key is set. Add one in Settings (the gear icon), or put YOUTUBE_API_KEY in .env.';

// ==========================================
// SAFETY FOR A LOCAL SERVER
// ==========================================
// No CORS: the app is always served by this same server (the Vite dev server proxies /api to it), so other
// websites can't make your browser talk to it. And only accept requests addressed to localhost, an IP address
// or a plain/.local hostname, which blocks "DNS rebinding" tricks from outside sites.
function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || net.isIP(host) !== 0 || host.endsWith('.local') || !host.includes('.');
}
app.use((req, res, next) => {
  if (!hostAllowed(req.headers.host)) return res.status(403).send('Unexpected host name.');
  next();
});

app.use(express.json({ limit: '2mb' })); // subscription imports can be a few hundred KB

// ==========================================
// CONFIG (all optional overrides in .env)
// ==========================================
const MAX_VIDEOS = Math.min(Number(process.env.MAX_VIDEOS_PER_CHANNEL) || 50, 50); // YouTube caps a page at 50
const MIN_DURATION_SECONDS = Number(process.env.MIN_VIDEO_SECONDS) || 61; // drops Shorts-length clips
const SYNC_TTL_HOURS = Number(process.env.SYNC_TTL_HOURS) || 24; // how old the cache may get before a refresh
const RETRY_COOLDOWN_MS = 5 * 60 * 1000; // don't hammer YouTube if a sync keeps failing
const EPG_WINDOW_HOURS = Number(process.env.EPG_WINDOW_HOURS) || 4; // how far ahead the guide's lineup reaches
const MAX_SOURCES_PER_CHANNEL = 100; // YouTube channels that can be grouped into one TV channel

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Parse ISO 8601 duration (e.g. "PT15M33S", "P1DT2H") to total seconds
function parseISODuration(duration) {
  const match = String(duration || '').match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
  );
  if (!match) return 0;
  const [, d, h, m, s] = match.map((x) => parseInt(x || 0, 10));
  return d * 86400 + h * 3600 + m * 60 + s;
}

// Thin wrapper over the YouTube Data API v3
async function yt(endpoint, params, apiKey) {
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/${endpoint}`, {
    params: { ...params, key: String(apiKey || process.env.YOUTUBE_API_KEY || '').trim() },
  });
  return res.data;
}

// Handle (@name), channel ID (UC...), or uploads playlist ID (UU...) -> { uploadsPlaylistId, title }
// A UC.../UU... ID maps straight to its uploads playlist, so the lookup call is only made when we want the title.
async function resolveChannel(input, { withTitle = true } = {}) {
  const isUU = /^UU[\w-]{22}$/.test(input);
  const isUC = /^UC[\w-]{22}$/.test(input);

  if (isUU || isUC) {
    const uploadsPlaylistId = isUU ? input : 'UU' + input.slice(2);
    if (!withTitle) return { uploadsPlaylistId, title: null };
    const items = (await yt('channels', { part: 'snippet', id: 'UC' + uploadsPlaylistId.slice(2) })).items || [];
    return { uploadsPlaylistId, title: items[0]?.snippet?.title || null };
  }

  const handle = input.replace('@', '');
  let items = (await yt('channels', { part: 'contentDetails,snippet', forHandle: handle })).items || [];
  if (items.length === 0) {
    items = (await yt('channels', { part: 'contentDetails,snippet', id: input })).items || [];
  }
  const item = items[0];
  return {
    uploadsPlaylistId: item?.contentDetails?.relatedPlaylists?.uploads || null,
    title: item?.snippet?.title || null,
  };
}

const saveTitle = db.prepare(
  'INSERT INTO source_titles (yt_channel_id, title) VALUES (?, ?) ON CONFLICT(yt_channel_id) DO UPDATE SET title = excluded.title'
);

// Readable name for a source: remembered YouTube title, else look it up once, else the raw key
async function getSourceTitle(key) {
  const row = db.prepare('SELECT title FROM source_titles WHERE yt_channel_id = ?').get(key);
  if (row) return row.title;
  if (process.env.YOUTUBE_API_KEY) {
    try {
      const { title } = await resolveChannel(key.replace(/\s+/g, ''));
      if (title) {
        saveTitle.run(key, title);
        return title;
      }
    } catch (err) {
      console.error('Could not look up channel title for', key, err.message);
    }
  }
  return key;
}

// The ONE place videos are read for scheduling. Always the same deterministic order,
// whether the data was just synced or cached, so the schedule never reshuffles.
function getChannelVideos(key) {
  return db
    .prepare('SELECT * FROM videos WHERE yt_channel_id = ? ORDER BY published_at ASC, yt_video_id ASC')
    .all(key);
}

function isCacheFresh(key) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM videos WHERE yt_channel_id = ? AND cached_at > datetime('now', ?)`)
    .get(key, `-${SYNC_TTL_HOURS} hours`);
  return row.n > 0;
}

// --- Sync ---------------------------------------------------------------
// Result: { ok, count, reason? }. On failure the existing cache is left untouched.
async function doSync(key) {
  if (!process.env.YOUTUBE_API_KEY) {
    return { ok: false, count: 0, reason: NO_KEY_MESSAGE };
  }

  const cleanInput = key.replace(/\s+/g, ''); // "Technology Connections" -> "TechnologyConnections"
  console.log(`\n--- Starting sync for: "${cleanInput}" ---`);

  try {
    const haveTitle = Boolean(db.prepare('SELECT 1 FROM source_titles WHERE yt_channel_id = ?').get(key));
    const { uploadsPlaylistId, title } = await resolveChannel(cleanInput, { withTitle: !haveTitle });
    if (!uploadsPlaylistId) {
      console.error(`Could not resolve channel or handle for: "${cleanInput}"`);
      return { ok: false, count: 0, reason: `Could not find a YouTube channel for "${key}"` };
    }

    const playlist = await yt('playlistItems', {
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: MAX_VIDEOS,
    });
    const videoIds = (playlist.items || []).map((i) => i.snippet.resourceId.videoId);
    if (videoIds.length === 0) {
      return { ok: false, count: 0, reason: 'That channel has no public videos' };
    }

    const details = await yt('videos', {
      part: 'contentDetails,snippet,status',
      id: videoIds.join(','),
    });

    // Keep only what can actually play in an embedded, scheduled loop
    const skipped = { short: 0, notEmbeddable: 0, live: 0 };
    const eligible = [];
    for (const item of details.items || []) {
      const seconds = parseISODuration(item.contentDetails?.duration);
      const live = item.snippet?.liveBroadcastContent;

      if (item.status?.embeddable === false) { skipped.notEmbeddable++; continue; }
      if (live && live !== 'none') { skipped.live++; continue; }
      if (seconds < MIN_DURATION_SECONDS) { skipped.short++; continue; }

      eligible.push({
        yt_video_id: item.id,
        title: item.snippet.title,
        duration_seconds: seconds,
        thumbnail_url: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || '',
        published_at: item.snippet.publishedAt,
      });
    }

    if (eligible.length === 0) {
      return { ok: false, count: 0, reason: 'No playable videos found (all were Shorts, live, or not embeddable)' };
    }

    // Upsert the fresh set, then drop anything for this channel that's no longer in it
    // (deleted, made private, filtered out). One transaction = no half-updated schedule.
    const upsert = db.prepare(`
      INSERT INTO videos (yt_video_id, yt_channel_id, title, duration_seconds, thumbnail_url, published_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(yt_channel_id, yt_video_id) DO UPDATE SET
        title = excluded.title,
        duration_seconds = excluded.duration_seconds,
        thumbnail_url = excluded.thumbnail_url,
        published_at = excluded.published_at,
        cached_at = CURRENT_TIMESTAMP
    `);
    const ids = eligible.map((v) => v.yt_video_id);
    db.transaction(() => {
      for (const v of eligible) {
        upsert.run(v.yt_video_id, key, v.title, v.duration_seconds, v.thumbnail_url, v.published_at);
      }
      db.prepare(
        `DELETE FROM videos WHERE yt_channel_id = ? AND yt_video_id NOT IN (${ids.map(() => '?').join(',')})`
      ).run(key, ...ids);
    })();

    if (title) saveTitle.run(key, title);

    console.log(
      `Synced ${eligible.length} videos (skipped: ${skipped.short} short, ` +
        `${skipped.notEmbeddable} not embeddable, ${skipped.live} live/upcoming)`
    );
    return { ok: true, count: eligible.length };
  } catch (error) {
    console.error('=== YOUTUBE API ERROR ===');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error Message:', error.message);
    }
    console.error('========================');
    const status = error.response?.status;
    return { ok: false, count: 0, reason: `YouTube API error${status ? ` (HTTP ${status})` : ''}` };
  }
}

// Concurrent requests for the same channel share one in-flight sync (no double quota spend)
const inflight = new Map();
const lastAttempt = new Map();

// At most a few YouTube syncs at a time. (With hundreds of channels, a daily refresh would otherwise start
// all of them at once and flood both the server and your API quota.)
const SYNC_CONCURRENCY = 3;
let activeSyncs = 0;
const syncQueue = [];

function runLimited(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeSyncs += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeSyncs -= 1;
          const next = syncQueue.shift();
          if (next) next();
        });
    };
    if (activeSyncs < SYNC_CONCURRENCY) run();
    else syncQueue.push(run);
  });
}

function syncChannel(key) {
  if (inflight.has(key)) return inflight.get(key);
  lastAttempt.set(key, Date.now());
  const p = runLimited(() => doSync(key)).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Videos for the guide. Blocks only for a channel that has nothing cached yet;
// stale caches are served immediately and refreshed in the background.
async function getVideosForEpg(key) {
  let videos = getChannelVideos(key);
  const sinceAttempt = Date.now() - (lastAttempt.get(key) || 0);

  if (videos.length === 0) {
    if (sinceAttempt > RETRY_COOLDOWN_MS) {
      await syncChannel(key);
      videos = getChannelVideos(key);
    }
  } else if (!isCacheFresh(key) && sinceAttempt > RETRY_COOLDOWN_MS) {
    syncChannel(key); // fire and forget; the next guide refresh picks it up
  }
  return videos;
}

// --- A TV channel = one or more YouTube sources ---------------------------
const stmtSources = db.prepare('SELECT yt_channel_id FROM channel_sources WHERE channel_id = ? ORDER BY id ASC');

// Accepts an array or a newline/comma separated string; trims and removes exact duplicates
function parseSources(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\n,]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const key = String(raw).trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// Make sure every source has playable videos cached (syncing the ones that don't).
// Returns a list of { source, reason } for the ones that can't be used.
async function ensureSourcesPlayable(keys) {
  const failures = [];
  await Promise.all(
    keys.map(async (key) => {
      if (getChannelVideos(key).length > 0) return;
      const result = await syncChannel(key);
      if (getChannelVideos(key).length === 0) {
        failures.push({ source: key, reason: result.reason || 'No playable videos found' });
      }
    })
  );
  return failures;
}

const describeFailures = (failures) =>
  'Could not use: ' + failures.map((f) => `"${f.source}" (${f.reason})`).join('; ');

// Forget cached videos that no TV channel uses any more
function pruneOrphanVideos() {
  return db
    .prepare('DELETE FROM videos WHERE yt_channel_id NOT IN (SELECT yt_channel_id FROM channel_sources)')
    .run().changes;
}

// Deterministic "shuffle": order by a hash of (channel, video). Adding a video drops it into a
// stable spot without reordering the rest, and the same channel always plays in the same order.
function stableOrder(videos, seed) {
  return videos
    .map((v) => ({ v, k: crypto.createHash('md5').update(`${seed}:${v.yt_video_id}`).digest('hex') }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.v);
}

// All videos for a TV channel: single source = chronological, group = stable shuffle
async function getChannelPlaylist(chan, keys) {
  const lists = await Promise.all(keys.map((k) => getVideosForEpg(k)));
  const byId = new Map();
  for (const v of lists.flat()) if (!byId.has(v.yt_video_id)) byId.set(v.yt_video_id, v);
  const merged = [...byId.values()];
  return keys.length > 1 ? stableOrder(merged, chan.id) : merged;
}

// Calculate virtual live programming math
function calculateLiveProgram(videos, windowHours = EPG_WINDOW_HOURS) {
  if (!videos || videos.length === 0) return null;

  const totalDuration = videos.reduce((sum, v) => sum + v.duration_seconds, 0);
  if (totalDuration === 0) return null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  let offset = nowSeconds % totalDuration;

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (offset < video.duration_seconds) {
      const nextVideo = videos[(i + 1) % videos.length];
      const upcomingVideo = videos[(i + 2) % videos.length];

      // The guide's lineup: the current program (with its true start time) and everything
      // after it, up to EPG_WINDOW_HOURS from now. Times are epoch milliseconds.
      const lineup = [];
      let startsAt = (nowSeconds - offset) * 1000;
      const windowEnd = nowSeconds * 1000 + windowHours * 3600 * 1000;
      const maxPrograms = Math.max(60, windowHours * 15);
      for (let k = i; startsAt < windowEnd && lineup.length < maxPrograms; k++) {
        const v = videos[k % videos.length];
        lineup.push({
          videoId: v.yt_video_id,
          title: v.title,
          startsAt,
          endsAt: startsAt + v.duration_seconds * 1000,
          durationSeconds: v.duration_seconds,
        });
        startsAt += v.duration_seconds * 1000;
      }

      return {
        current: {
          videoId: video.yt_video_id,
          title: video.title,
          seekToSeconds: offset,
          durationSeconds: video.duration_seconds,
          thumbnailUrl: video.thumbnail_url,
        },
        next: nextVideo ? { title: nextVideo.title, durationSeconds: nextVideo.duration_seconds } : null,
        upcoming: upcomingVideo ? { title: upcomingVideo.title, durationSeconds: upcomingVideo.duration_seconds } : null,
        lineup,
      };
    }
    offset -= video.duration_seconds;
  }

  return null;
}

// ==========================================
// API ROUTES
// ==========================================

// --- PIN checking with a simple lockout (a 4-digit PIN would otherwise be trivial to brute-force) ---
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 60 * 1000;
const pinFailures = new Map(); // profileId -> { count, lockedUntil }

// -> { ok: true } | { ok: false, status, error }. Profiles without a PIN always pass.
function checkPin(profile, pin) {
  if (!profile.pin_code) return { ok: true };

  const now = Date.now();
  const rec = pinFailures.get(profile.id) || { count: 0, lockedUntil: 0 };
  if (rec.lockedUntil > now) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000);
    return { ok: false, status: 429, error: `Too many wrong PINs. Try again in ${secs} seconds.` };
  }

  if (bcrypt.compareSync(String(pin ?? ''), profile.pin_code)) {
    pinFailures.delete(profile.id);
    return { ok: true };
  }

  rec.count += 1;
  if (rec.count >= PIN_MAX_FAILURES) {
    rec.count = 0;
    rec.lockedUntil = now + PIN_LOCK_MS;
  }
  pinFailures.set(profile.id, rec);
  return { ok: false, status: 401, error: 'Incorrect PIN.' };
}

const getProfile = db.prepare('SELECT * FROM profiles WHERE id = ?');
const THEME_PRESETS = ['classic', '70s', '80s', '90s'];
const parseTheme = (raw) => {
  try {
    const t = JSON.parse(raw);
    return t && typeof t === 'object' ? t : null;
  } catch {
    return null;
  }
};
const isValidName = (name) => name.length >= 1 && name.length <= 30;
const isValidAvatar = (avatar) => [...avatar].length >= 1 && [...avatar].length <= 8;

// 1. Get all family profiles (never expose PIN hashes; just say whether one is set)
app.get('/api/profiles', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.avatar, p.theme, (p.pin_code IS NOT NULL) AS has_pin,
              (SELECT COUNT(*) FROM channels c WHERE c.profile_id = p.id) AS channel_count
       FROM profiles p ORDER BY p.id ASC`
    )
    .all();
  res.json(rows.map((r) => ({ ...r, has_pin: Boolean(r.has_pin), theme: parseTheme(r.theme) })));
});

// 2. Add a new profile
app.post('/api/profiles', (req, res) => {
  const { name, avatar, pin_code } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanAvatar = String(avatar || '').trim() || '📺';
  if (!isValidName(cleanName)) return res.status(400).json({ error: 'Profile name must be 1-30 characters.' });
  if (!isValidAvatar(cleanAvatar)) return res.status(400).json({ error: 'Pick a single emoji for the avatar.' });

  let pinHash = null;
  if (pin_code !== undefined && pin_code !== null && pin_code !== '') {
    if (!/^\d{4,8}$/.test(String(pin_code))) {
      return res.status(400).json({ error: 'PIN must be 4-8 digits.' });
    }
    pinHash = bcrypt.hashSync(String(pin_code), 10);
  }

  try {
    const result = db
      .prepare('INSERT INTO profiles (name, avatar, pin_code) VALUES (?, ?, ?)')
      .run(cleanName, cleanAvatar, pinHash);
    res.json({ id: Number(result.lastInsertRowid), name: cleanName, avatar: cleanAvatar, has_pin: Boolean(pinHash), channel_count: 0 });
  } catch (err) {
    res.status(409).json({ error: 'A profile with that name already exists.' });
  }
});

// 2b. Edit a profile: name, avatar and/or PIN. A PIN-protected profile needs its current PIN for any change.
//     pin_code: a 4-8 digit string sets/changes the PIN; null or "" removes it; omit to leave it alone.
app.put('/api/profiles/:id', (req, res) => {
  const profile = getProfile.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  const body = req.body || {};
  const gate = checkPin(profile, body.current_pin);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const name = body.name !== undefined ? String(body.name).trim() : profile.name;
  const avatar = body.avatar !== undefined ? String(body.avatar).trim() || '📺' : profile.avatar;
  if (!isValidName(name)) return res.status(400).json({ error: 'Profile name must be 1-30 characters.' });
  if (!isValidAvatar(avatar)) return res.status(400).json({ error: 'Pick a single emoji for the avatar.' });

  let pinHash = profile.pin_code;
  if ('pin_code' in body) {
    if (body.pin_code === null || body.pin_code === '') {
      pinHash = null;
    } else if (!/^\d{4,8}$/.test(String(body.pin_code))) {
      return res.status(400).json({ error: 'PIN must be 4-8 digits.' });
    } else {
      pinHash = bcrypt.hashSync(String(body.pin_code), 10);
    }
  }

  try {
    db.prepare('UPDATE profiles SET name = ?, avatar = ?, pin_code = ? WHERE id = ?').run(name, avatar, pinHash, profile.id);
    res.json({ id: profile.id, name, avatar, has_pin: Boolean(pinHash) });
  } catch (err) {
    res.status(409).json({ error: 'A profile with that name already exists.' });
  }
});

// 2c. Delete a profile and all of its channels (needs the PIN if it has one; the last profile can't be deleted)
app.delete('/api/profiles/:id', (req, res) => {
  const profile = getProfile.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  if (db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n <= 1) {
    return res.status(400).json({ error: "You can't delete the last remaining profile." });
  }

  const gate = checkPin(profile, req.body?.pin);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const deletedChannels = db.transaction(() => {
    db.prepare('DELETE FROM channel_sources WHERE channel_id IN (SELECT id FROM channels WHERE profile_id = ?)').run(profile.id);
    const removed = db.prepare('DELETE FROM channels WHERE profile_id = ?').run(profile.id).changes;
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id);
    return removed;
  })();

  pinFailures.delete(profile.id);
  res.json({ ok: true, deletedChannels, prunedVideos: pruneOrphanVideos() });
});

// 2c-2. Save a profile's color theme. Purely cosmetic, so it doesn't need the PIN.
app.put('/api/profiles/:id/theme', (req, res) => {
  const profile = getProfile.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  const { preset, accent } = req.body || {};
  if (!THEME_PRESETS.includes(preset)) return res.status(400).json({ error: 'Unknown theme.' });
  if (accent !== null && accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    return res.status(400).json({ error: 'The accent color must look like #ff3399.' });
  }

  const theme = { preset, accent: accent ? accent.toLowerCase() : null };
  db.prepare('UPDATE profiles SET theme = ? WHERE id = ?').run(JSON.stringify(theme), profile.id);
  res.json(theme);
});

// 2d. Check a profile PIN (no session/JWT: this only answers yes/no, so it gates the UI, not the API)
app.post('/api/profiles/:id/verify-pin', (req, res) => {
  const profile = getProfile.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  const gate = checkPin(profile, req.body?.pin);
  if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
  res.json({ ok: true });
});

// 3. Get EPG guide & live schedules for a profile
app.get('/api/epg/:profileId', async (req, res) => {
  // ?hours=8 asks for a longer lineup (the TV guide uses it so you can browse ahead); default is EPG_WINDOW_HOURS
  const hoursAsked = Number(req.query.hours);
  const windowHours = Number.isFinite(hoursAsked) && hoursAsked > 0 ? Math.min(12, Math.max(1, hoursAsked)) : EPG_WINDOW_HOURS;
  const channels = db
    .prepare('SELECT * FROM channels WHERE profile_id = ? ORDER BY channel_number ASC')
    .all(req.params.profileId);

  const guideData = await Promise.all(
    channels.map(async (chan) => {
      const sources = stmtSources.all(chan.id).map((r) => r.yt_channel_id);
      const videos = await getChannelPlaylist(chan, sources);
      const liveProgram = calculateLiveProgram(videos, windowHours);

      return {
        id: chan.id,
        number: chan.channel_number,
        name: chan.name,
        category: chan.category,
        sources,
        schedule: liveProgram || {
          current: { videoId: 'dQw4w9WgXcQ', title: 'Off Air / Signal Testing', seekToSeconds: 0, durationSeconds: 300 },
          next: { title: 'Station Identification', durationSeconds: 300 },
          upcoming: { title: 'Sign Off', durationSeconds: 300 },
        },
      };
    })
  );

  // serverNow lets the browser (or a TV whose clock is off) line the guide's times up with the server's clock
  res.json({ serverNow: Date.now(), channels: guideData });
});

// 4. Add a channel to a profile. `sources` is one or more YouTube channels (handle, UC... ID or UU... ID),
//    as an array or a newline/comma separated string. Everything is validated before anything is saved.
app.post('/api/channels', async (req, res) => {
  const { profile_id, channel_number, name, category } = req.body || {};
  const sources = parseSources(req.body?.sources ?? req.body?.yt_channel_id); // yt_channel_id = old single-source form
  const cleanName = String(name || '').trim();
  const number = Number(channel_number);

  if (!profile_id || !Number.isInteger(number) || number < 1 || !cleanName || sources.length === 0) {
    return res.status(400).json({ error: 'Profile, channel number, name and at least one YouTube channel are required.' });
  }
  if (sources.length > MAX_SOURCES_PER_CHANNEL) {
    return res.status(400).json({ error: `A channel can group at most ${MAX_SOURCES_PER_CHANNEL} YouTube channels.` });
  }
  if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profile_id)) {
    return res.status(404).json({ error: 'Profile not found.' });
  }
  if (db.prepare('SELECT 1 FROM channels WHERE profile_id = ? AND channel_number = ?').get(profile_id, number)) {
    return res.status(409).json({ error: `Channel ${number} is already taken on this profile.` });
  }

  const failures = await ensureSourcesPlayable(sources);
  if (failures.length > 0) {
    return res.status(422).json({ error: describeFailures(failures), failures });
  }

  try {
    const insertChannel = db.prepare(
      'INSERT INTO channels (profile_id, channel_number, name, category, yt_channel_id) VALUES (?, ?, ?, ?, ?)'
    );
    const insertSource = db.prepare('INSERT INTO channel_sources (channel_id, yt_channel_id) VALUES (?, ?)');
    const id = db.transaction(() => {
      const result = insertChannel.run(profile_id, number, cleanName, category || 'General', sources[0]);
      const channelId = Number(result.lastInsertRowid);
      for (const key of sources) insertSource.run(channelId, key);
      return channelId;
    })();
    res.json({ id, message: 'Channel added successfully' });
  } catch (err) {
    console.error('Failed to add channel:', err.message);
    res.status(409).json({ error: `Channel ${number} is already taken on this profile.` });
  }
});

// 4b. Edit a channel: name, number, category and/or its list of YouTube sources (add/remove to group/ungroup)
app.put('/api/channels/:id', async (req, res) => {
  const chan = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!chan) return res.status(404).json({ error: 'Channel not found.' });

  const body = req.body || {};
  const name = body.name !== undefined ? String(body.name).trim() : chan.name;
  const category = body.category !== undefined ? String(body.category).trim() || 'General' : chan.category;
  const number = body.channel_number !== undefined ? Number(body.channel_number) : chan.channel_number;
  const sources = body.sources !== undefined ? parseSources(body.sources) : null;

  if (!name || !Number.isInteger(number) || number < 1) {
    return res.status(400).json({ error: 'A channel needs a name and a positive channel number.' });
  }
  if (sources && (sources.length === 0 || sources.length > MAX_SOURCES_PER_CHANNEL)) {
    return res.status(400).json({ error: `A channel needs between 1 and ${MAX_SOURCES_PER_CHANNEL} YouTube channels.` });
  }
  if (
    number !== chan.channel_number &&
    db.prepare('SELECT 1 FROM channels WHERE profile_id = ? AND channel_number = ? AND id != ?').get(chan.profile_id, number, chan.id)
  ) {
    return res.status(409).json({ error: `Channel ${number} is already taken on this profile.` });
  }

  if (sources) {
    const failures = await ensureSourcesPlayable(sources);
    if (failures.length > 0) return res.status(422).json({ error: describeFailures(failures), failures });
  }

  try {
    db.transaction(() => {
      db.prepare('UPDATE channels SET name = ?, category = ?, channel_number = ? WHERE id = ?').run(
        name, category, number, chan.id
      );
      if (sources) {
        db.prepare(
          `DELETE FROM channel_sources WHERE channel_id = ? AND yt_channel_id NOT IN (${sources.map(() => '?').join(',')})`
        ).run(chan.id, ...sources);
        const insertSource = db.prepare('INSERT OR IGNORE INTO channel_sources (channel_id, yt_channel_id) VALUES (?, ?)');
        for (const key of sources) insertSource.run(chan.id, key);
        db.prepare('UPDATE channels SET yt_channel_id = ? WHERE id = ?').run(sources[0], chan.id);
      }
    })();
    pruneOrphanVideos();
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to update channel:', err.message);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// 4c. Delete a channel (its sources go with it; cached videos nothing else uses are cleaned up)
app.delete('/api/channels/:id', (req, res) => {
  const result = db.transaction(() => {
    db.prepare('DELETE FROM channel_sources WHERE channel_id = ?').run(req.params.id);
    return db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
  })();
  if (result.changes === 0) return res.status(404).json({ error: 'Channel not found.' });
  res.json({ ok: true, prunedVideos: pruneOrphanVideos() });
});

// 4d. Group existing channels into one. The lowest-numbered selected channel survives (keeping its number
//     and category), takes the combined sources of all of them, and the others are removed.
app.post('/api/channels/merge', (req, res) => {
  const { profile_id, name } = req.body || {};
  const ids = [...new Set((req.body?.channel_ids || []).map(Number))].filter(Number.isInteger);
  if (!profile_id || ids.length < 2) {
    return res.status(400).json({ error: 'Pick at least two channels to group.' });
  }

  const rows = db
    .prepare(`SELECT * FROM channels WHERE profile_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY channel_number ASC`)
    .all(profile_id, ...ids);
  if (rows.length !== ids.length) {
    return res.status(404).json({ error: 'One or more of those channels no longer exist on this profile.' });
  }

  const target = rows[0];
  const keys = [];
  for (const row of rows) {
    for (const r of stmtSources.all(row.id)) if (!keys.includes(r.yt_channel_id)) keys.push(r.yt_channel_id);
  }
  if (keys.length > MAX_SOURCES_PER_CHANNEL) {
    return res.status(400).json({ error: `That would group ${keys.length} YouTube channels; the limit is ${MAX_SOURCES_PER_CHANNEL}.` });
  }

  const cleanName = String(name || '').trim() || target.name;
  const others = rows.slice(1).map((r) => r.id);

  db.transaction(() => {
    db.prepare(`DELETE FROM channel_sources WHERE channel_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    db.prepare(`DELETE FROM channels WHERE id IN (${others.map(() => '?').join(',')})`).run(...others);
    db.prepare('UPDATE channels SET name = ?, yt_channel_id = ? WHERE id = ?').run(cleanName, keys[0], target.id);
    const insertSource = db.prepare('INSERT INTO channel_sources (channel_id, yt_channel_id) VALUES (?, ?)');
    for (const key of keys) insertSource.run(target.id, key);
  })();

  res.json({ ok: true, id: target.id, number: target.channel_number, sources: keys.length });
});

// 4e. Ungroup: every YouTube source becomes its own channel, named after the YouTube channel.
//     The first one stays on this channel's number; the rest are added at the end of the lineup.
app.post('/api/channels/:id/split', async (req, res) => {
  const chan = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!chan) return res.status(404).json({ error: 'Channel not found.' });

  const keys = stmtSources.all(chan.id).map((r) => r.yt_channel_id);
  if (keys.length < 2) return res.status(400).json({ error: 'That channel only has one YouTube source.' });

  const titles = await Promise.all(keys.map(getSourceTitle));

  const created = db.transaction(() => {
    let nextNumber = db.prepare('SELECT MAX(channel_number) AS n FROM channels WHERE profile_id = ?').get(chan.profile_id).n;

    db.prepare('UPDATE channels SET name = ?, yt_channel_id = ? WHERE id = ?').run(titles[0], keys[0], chan.id);
    db.prepare('DELETE FROM channel_sources WHERE channel_id = ? AND yt_channel_id != ?').run(chan.id, keys[0]);

    const insertChannel = db.prepare(
      'INSERT INTO channels (profile_id, channel_number, name, category, yt_channel_id) VALUES (?, ?, ?, ?, ?)'
    );
    const insertSource = db.prepare('INSERT INTO channel_sources (channel_id, yt_channel_id) VALUES (?, ?)');
    const out = [{ id: chan.id, number: chan.channel_number, name: titles[0] }];
    for (let i = 1; i < keys.length; i++) {
      nextNumber += 1;
      const id = Number(insertChannel.run(chan.profile_id, nextNumber, titles[i], chan.category, keys[i]).lastInsertRowid);
      insertSource.run(id, keys[i]);
      out.push({ id, number: nextNumber, name: titles[i] });
    }
    return out;
  })();

  res.json({ ok: true, channels: created });
});

// 4f. Delete several channels at once (scoped to one profile). Cached videos nothing else uses are cleaned up.
app.post('/api/channels/bulk-delete', (req, res) => {
  const { profile_id } = req.body || {};
  const ids = [...new Set((req.body?.channel_ids || []).map(Number))].filter(Number.isInteger);
  if (!profile_id || ids.length === 0) {
    return res.status(400).json({ error: 'Pick at least one channel to delete.' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const deleted = db.transaction(() => {
    db.prepare(
      `DELETE FROM channel_sources WHERE channel_id IN (SELECT id FROM channels WHERE profile_id = ? AND id IN (${placeholders}))`
    ).run(profile_id, ...ids);
    return db.prepare(`DELETE FROM channels WHERE profile_id = ? AND id IN (${placeholders})`).run(profile_id, ...ids).changes;
  })();

  res.json({ ok: true, deleted, prunedVideos: pruneOrphanVideos() });
});

// 5. Force refresh / resync channel videos
app.get('/api/sync/:ytChannelId', async (req, res) => {
  const key = String(req.params.ytChannelId).trim();
  const result = await syncChannel(key);
  res.json({ ...result, syncedCount: result.count, videos: getChannelVideos(key) });
});

// ==========================================
// SUBSCRIPTION IMPORT (Google Takeout subscriptions.csv, parsed in the browser)
// ==========================================
const IMPORT_MAX = 500; // channels per import (each costs ~2 YouTube quota units)
const IMPORT_CONCURRENCY = 4;
const UC_ID_RE = /^UC[\w-]{22}$/;
const importJobs = new Map();

async function runPool(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    })
  );
}

async function runImportJob(job, { profileId, mode, groupName, subs }) {
  try {
    // Remember the titles from the CSV so ungrouping later gives readable names for free
    for (const s of subs) saveTitle.run(s.id, s.title);

    // Skip channels this profile already has
    const existing = new Set(
      db
        .prepare(
          'SELECT cs.yt_channel_id FROM channel_sources cs JOIN channels c ON c.id = cs.channel_id WHERE c.profile_id = ?'
        )
        .all(profileId)
        .map((r) => r.yt_channel_id)
    );
    const todo = [];
    for (const s of subs) {
      if (existing.has(s.id)) job.skipped.push(s.title);
      else todo.push(s);
    }
    job.done = job.skipped.length;

    // Sync each one (a few at a time) so only channels with playable videos become TV channels
    const good = [];
    let quotaHit = false;
    await runPool(todo, IMPORT_CONCURRENCY, async (s) => {
      try {
        if (quotaHit) {
          job.failed.push({ title: s.title, reason: 'Skipped: the YouTube API quota may be used up' });
          return;
        }
        if (getChannelVideos(s.id).length === 0) {
          const result = await syncChannel(s.id);
          if (!result.ok && /HTTP 403/.test(result.reason || '')) quotaHit = true;
          if (getChannelVideos(s.id).length === 0) {
            job.failed.push({ title: s.title, reason: result.reason || 'No playable videos found' });
            return;
          }
        }
        good.push(s);
      } finally {
        job.done += 1;
      }
    });

    // Create the TV channels in one transaction, alphabetical, after the highest existing number
    job.status = 'saving';
    good.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));

    if (good.length > 0) {
      db.transaction(() => {
        let number = db.prepare('SELECT MAX(channel_number) AS n FROM channels WHERE profile_id = ?').get(profileId).n || 0;
        const insertChannel = db.prepare(
          'INSERT INTO channels (profile_id, channel_number, name, category, yt_channel_id) VALUES (?, ?, ?, ?, ?)'
        );
        const insertSource = db.prepare('INSERT INTO channel_sources (channel_id, yt_channel_id) VALUES (?, ?)');

        const make = (name, keys) => {
          number += 1;
          const id = Number(insertChannel.run(profileId, number, name, 'Imported', keys[0]).lastInsertRowid);
          for (const key of keys) insertSource.run(id, key);
          job.created.push({ id, number, name, sources: keys.length });
        };

        if (mode === 'group') {
          const keys = good.map((s) => s.id);
          const chunks = [];
          for (let i = 0; i < keys.length; i += MAX_SOURCES_PER_CHANNEL) chunks.push(keys.slice(i, i + MAX_SOURCES_PER_CHANNEL));
          chunks.forEach((chunk, i) => make(chunks.length > 1 ? `${groupName} ${i + 1}` : groupName, chunk));
        } else {
          for (const s of good) make(s.title, [s.id]);
        }
      })();
    }

    job.status = 'done';
  } catch (err) {
    console.error('Subscription import failed:', err);
    job.status = 'error';
    job.error = err.message;
  }
}

// Start an import. Returns immediately with a job id; poll GET /api/import/:jobId for progress.
app.post('/api/import/subscriptions', (req, res) => {
  const { profile_id, mode, group_name } = req.body || {};
  if (!process.env.YOUTUBE_API_KEY) return res.status(400).json({ error: NO_KEY_MESSAGE });
  if (!profile_id || !db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profile_id)) {
    return res.status(404).json({ error: 'Profile not found.' });
  }

  const seen = new Set();
  const subs = [];
  for (const item of req.body?.subscriptions || []) {
    const id = String(item?.id || '').trim();
    if (!UC_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    subs.push({ id, title: String(item?.title || '').replace(/\s+/g, ' ').trim() || id });
  }
  if (subs.length === 0) return res.status(400).json({ error: 'No valid YouTube channels to import.' });
  if (subs.length > IMPORT_MAX) {
    return res.status(400).json({ error: `Import at most ${IMPORT_MAX} channels at a time (you selected ${subs.length}).` });
  }

  const job = {
    id: crypto.randomUUID(),
    status: 'syncing', // syncing -> saving -> done | error
    total: subs.length,
    done: 0,
    skipped: [], // already in this profile's lineup
    failed: [], // [{ title, reason }]
    created: [], // [{ id, number, name, sources }]
    error: null,
  };
  importJobs.set(job.id, job);
  setTimeout(() => importJobs.delete(job.id), 30 * 60 * 1000).unref();

  runImportJob(job, {
    profileId: Number(profile_id),
    mode: mode === 'group' ? 'group' : 'separate',
    groupName: String(group_name || '').trim() || 'Subscriptions',
    subs,
  });

  res.json({ jobId: job.id, total: subs.length });
});

app.get('/api/import/:jobId', (req, res) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Import not found (it may have expired or the server restarted).' });
  res.json(job);
});

// ==========================================
// LINEUP EXPORT / IMPORT (share a channel lineup as a small file: no API key, PINs or profiles)
// ==========================================
const LINEUP_FORMAT = 'retro-cable-tv-lineup';

// Download this profile's channels, groupings and theme
app.get('/api/profiles/:id/lineup', (req, res) => {
  const profile = getProfile.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });

  const rows = db.prepare('SELECT * FROM channels WHERE profile_id = ? ORDER BY channel_number ASC').all(profile.id);
  const channels = rows.map((c) => {
    const sources = stmtSources.all(c.id).map((r) => r.yt_channel_id);
    return {
      number: c.channel_number,
      name: c.name,
      category: c.category,
      sources: sources.map((id) => {
        const t = db.prepare('SELECT title FROM source_titles WHERE yt_channel_id = ?').get(id);
        return t ? { id, title: t.title } : { id };
      }),
    };
  });

  let theme = null;
  try {
    theme = profile.theme ? JSON.parse(profile.theme) : null;
  } catch {
    /* ignore a bad theme */
  }
  res.json({ format: LINEUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), theme, channels });
});

// Start importing a lineup file into a profile. Poll GET /api/import/:jobId (same as subscription imports).
app.post('/api/profiles/:id/lineup/import', (req, res) => {
  const profile = getProfile.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  if (!process.env.YOUTUBE_API_KEY) return res.status(400).json({ error: NO_KEY_MESSAGE });

  const file = req.body?.lineup;
  if (!file || file.format !== LINEUP_FORMAT || !Array.isArray(file.channels)) {
    return res.status(400).json({ error: "That doesn't look like a Retro-Cable TV lineup file." });
  }

  // Clean everything: this file may have come from anyone
  const channels = [];
  for (const c of file.channels.slice(0, 2000)) {
    const sources = [];
    const seen = new Set();
    for (const s of Array.isArray(c?.sources) ? c.sources : []) {
      const id = String(s?.id || '').trim();
      if (!UC_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      sources.push({ id, title: String(s?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
    }
    const name = String(c?.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!name || sources.length === 0) continue;
    channels.push({
      number: Number.isInteger(c.number) && c.number > 0 ? c.number : 0,
      name,
      category: String(c?.category || 'General').trim().slice(0, 60) || 'General',
      sources: sources.slice(0, MAX_SOURCES_PER_CHANNEL),
    });
  }
  if (channels.length === 0) return res.status(400).json({ error: 'That lineup file has no usable channels.' });

  const uniqueIds = new Set(channels.flatMap((c) => c.sources.map((s) => s.id)));
  if (uniqueIds.size > IMPORT_MAX) {
    return res.status(400).json({
      error: `That lineup has ${uniqueIds.size} YouTube channels; the limit per import is ${IMPORT_MAX}.`,
    });
  }

  let theme = null;
  if (req.body?.applyTheme && file.theme && THEME_PRESETS.includes(file.theme.preset)) {
    const accent = /^#[0-9a-fA-F]{6}$/.test(file.theme.accent || '') ? file.theme.accent.toLowerCase() : null;
    theme = { preset: file.theme.preset, accent };
  }

  const job = {
    id: crypto.randomUUID(),
    status: 'syncing',
    total: uniqueIds.size,
    done: 0,
    skipped: [],
    failed: [],
    created: [],
    error: null,
  };
  importJobs.set(job.id, job);
  setTimeout(() => importJobs.delete(job.id), 30 * 60 * 1000).unref();
  runLineupJob(job, profile.id, channels, theme);
  res.json({ jobId: job.id, total: job.total });
});

async function runLineupJob(job, profileId, channels, theme) {
  try {
    for (const c of channels) for (const s of c.sources) if (s.title) saveTitle.run(s.id, s.title);

    // Skip YouTube channels this profile already has
    const existing = new Set(
      db
        .prepare('SELECT cs.yt_channel_id FROM channel_sources cs JOIN channels c ON c.id = cs.channel_id WHERE c.profile_id = ?')
        .all(profileId)
        .map((r) => r.yt_channel_id)
    );

    const todo = [];
    const queued = new Set();
    for (const c of channels) {
      for (const s of c.sources) {
        if (existing.has(s.id)) {
          if (!queued.has(s.id)) job.skipped.push(s.title || s.id);
        } else if (!queued.has(s.id)) todo.push(s);
        queued.add(s.id);
      }
    }
    job.done = job.skipped.length;

    const playable = new Set();
    let quotaHit = false;
    await runPool(todo, IMPORT_CONCURRENCY, async (s) => {
      try {
        if (quotaHit) {
          job.failed.push({ title: s.title || s.id, reason: 'Skipped: the YouTube API quota may be used up' });
          return;
        }
        if (getChannelVideos(s.id).length === 0) {
          const result = await syncChannel(s.id);
          if (!result.ok && /HTTP 403/.test(result.reason || '')) quotaHit = true;
          if (getChannelVideos(s.id).length === 0) {
            job.failed.push({ title: s.title || s.id, reason: result.reason || 'No playable videos found' });
            return;
          }
        }
        playable.add(s.id);
      } finally {
        job.done += 1;
      }
    });

    job.status = 'saving';
    db.transaction(() => {
      const taken = new Set(
        db.prepare('SELECT channel_number FROM channels WHERE profile_id = ?').all(profileId).map((r) => r.channel_number)
      );
      let next = Math.max(0, ...taken);
      const insertChannel = db.prepare(
        'INSERT INTO channels (profile_id, channel_number, name, category, yt_channel_id) VALUES (?, ?, ?, ?, ?)'
      );
      const insertSource = db.prepare('INSERT INTO channel_sources (channel_id, yt_channel_id) VALUES (?, ?)');
      const used = new Set(existing);

      for (const c of [...channels].sort((a, b) => (a.number || 1e9) - (b.number || 1e9))) {
        const keys = c.sources.map((s) => s.id).filter((id) => playable.has(id) && !used.has(id));
        if (keys.length === 0) continue;
        keys.forEach((k) => used.add(k));
        // keep the original number when it's free, otherwise add at the end
        let number = c.number;
        if (!number || taken.has(number)) number = ++next;
        else next = Math.max(next, number);
        taken.add(number);
        const id = Number(insertChannel.run(profileId, number, c.name, c.category, keys[0]).lastInsertRowid);
        for (const key of keys) insertSource.run(id, key);
        job.created.push({ id, number, name: c.name, sources: keys.length });
      }
      if (theme) db.prepare('UPDATE profiles SET theme = ? WHERE id = ?').run(JSON.stringify(theme), profileId);
    })();

    job.themeApplied = Boolean(theme);
    job.status = 'done';
  } catch (err) {
    console.error('Lineup import failed:', err);
    job.status = 'error';
    job.error = err.message;
  }
}

// ==========================================
// SETTINGS ROUTES
// ==========================================
const runtime = { port: null, host: null, rebind: null };

// Only requests coming from this very computer may change settings (a TV or phone on your network can't)
const isLoopback = (req) => {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
};

function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) if (nic.family === 'IPv4' && !nic.internal) urls.push(`http://${nic.address}:${port}`);
  }
  return urls;
}

function settingsView(req) {
  const key = String(process.env.YOUTUBE_API_KEY || '').trim();
  const local = isLoopback(req);
  return {
    hasApiKey: Boolean(key),
    apiKeyHint: key ? `...${key.slice(-4)}` : '',
    canEdit: local,
    lanAccess: lanEnabled(),
    lanUrls: local && lanEnabled() ? lanUrls(runtime.port) : [],
    port: runtime.port,
  };
}

app.get('/api/settings', (req, res) => res.json(settingsView(req)));

app.put('/api/settings', async (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: 'Settings can only be changed on the computer that runs Retro-Cable TV.' });
  }
  const body = req.body || {};

  if (body.youtubeApiKey !== undefined) {
    const key = String(body.youtubeApiKey).trim();
    if (key) {
      // Check the key with YouTube before keeping it (one quota unit)
      try {
        await yt('channels', { part: 'id', forHandle: 'YouTube' }, key);
      } catch (err) {
        const apiError = err.response?.data?.error;
        if (apiError?.errors?.[0]?.reason !== 'quotaExceeded') {
          return res.status(400).json({
            error: apiError?.message
              ? `YouTube didn't accept that key: ${apiError.message}`
              : "Couldn't check the key with YouTube. Is this computer online?",
          });
        }
      }
      process.env.YOUTUBE_API_KEY = key;
    } else {
      delete process.env.YOUTUBE_API_KEY;
    }
    settings.youtubeApiKey = key;
  }

  let rebindNeeded = false;
  if (body.lanAccess !== undefined && Boolean(body.lanAccess) !== Boolean(settings.lanAccess)) {
    settings.lanAccess = Boolean(body.lanAccess);
    rebindNeeded = true;
  }

  saveSettings();
  res.json(settingsView(req));
  // Switching between "this computer only" and "my whole network" restarts the listener, after this reply is sent
  if (rebindNeeded) res.on('finish', () => runtime.rebind?.().catch((err) => console.error('Could not switch network mode:', err.message)));
});

// A page to open in a TV's web browser: reports what the TV can do (styling, speed, YouTube, remote keys)
app.get('/tv-check', (req, res) => res.sendFile(path.join(__dirname, 'server', 'tv-check.html')));

// ==========================================
// THE APP ITSELF (the built React files), when they exist
// ==========================================
const STATIC_DIR = process.env.RETROTV_STATIC_DIR || path.join(__dirname, 'dist');
if (fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
  app.use(express.static(STATIC_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
}

// ==========================================
// START / STOP
// ==========================================
function listenOn(port, host) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host);
    srv.once('listening', () => resolve(srv));
    srv.once('error', reject);
  });
}

const closeServer = (srv) =>
  new Promise((resolve) => {
    srv.closeAllConnections?.();
    srv.close(() => resolve());
  });

// Starts listening (on 127.0.0.1, or on the whole network if enabled in Settings). If the port is taken, tries the next few.
async function startServer({ port = Number(process.env.PORT) || 3001 } = {}) {
  const hostNow = () => (lanEnabled() ? '0.0.0.0' : '127.0.0.1');

  let httpServer = null;
  for (let i = 0; i < 10 && !httpServer; i++) {
    try {
      httpServer = await listenOn(port + i, hostNow());
      runtime.port = port + i;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || i === 9) throw err;
    }
  }
  runtime.host = hostNow();

  runtime.rebind = async () => {
    await closeServer(httpServer);
    httpServer = await listenOn(runtime.port, hostNow());
    runtime.host = hostNow();
    console.log(`Now listening on ${runtime.host}:${runtime.port}`);
  };

  console.log(`=================================`);
  console.log(`Retro-Cable TV server active!`);
  console.log(`On this computer:  http://127.0.0.1:${runtime.port}`);
  if (lanEnabled()) for (const url of lanUrls(runtime.port)) console.log(`On your network:   ${url}`);
  console.log(`Data folder:       ${DATA_DIR}`);
  console.log(`=================================`);

  return { port: runtime.port, close: () => closeServer(httpServer) };
}

module.exports = { startServer, app };

// `node server.cjs` starts it directly; the desktop app requires this file and calls startServer() itself
if (require.main === module) {
  startServer().catch((err) => {
    console.error('Could not start the server:', err);
    process.exit(1);
  });
}
