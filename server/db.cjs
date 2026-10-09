const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Opening the database.
//
// Plain Node (npm run server):  better-sqlite3, as before.
// Packaged desktop app:          Node's built-in node:sqlite (Node 22+, which Electron ships), so there is
//                                no native module to compile for Windows / macOS / Raspberry Pi.
// Both are wrapped to look the same to the rest of the server (prepare / get / all / run / transaction).
// ---------------------------------------------------------------------------
function wrapNodeSqlite(raw) {
  let depth = 0;
  const bigToNumber = (v) => (typeof v === 'bigint' ? Number(v) : v);

  return {
    exec: (sql) => raw.exec(sql),
    pragma: (text) => raw.exec(`PRAGMA ${text}`),
    close: () => raw.close(),
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run: (...args) => {
          const r = stmt.run(...args);
          return { changes: bigToNumber(r.changes), lastInsertRowid: bigToNumber(r.lastInsertRowid) };
        },
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      };
    },
    // db.transaction(fn) returns a function that runs fn atomically (nested calls become savepoints)
    transaction(fn) {
      return (...args) => {
        const name = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
        depth += 1;
        try {
          const result = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
          return result;
        } catch (err) {
          depth -= 1;
          raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
          throw err;
        }
      };
    },
  };
}

function openDatabase(file) {
  // Inside Electron, better-sqlite3 would need rebuilding for Electron's own Node, so go straight to node:sqlite
  if (!process.versions.electron) {
    try {
      const Database = require('better-sqlite3');
      return new Database(file);
    } catch (err) {
      console.warn('better-sqlite3 is not available (' + err.message.split('\n')[0] + '); trying node:sqlite');
    }
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    return wrapNodeSqlite(new DatabaseSync(file));
  } catch (err) {
    throw new Error(
      'No SQLite driver available. Install better-sqlite3 (npm install) or use Node.js 22.13 or newer. ' + err.message
    );
  }
}

// Where the database lives: RETROTV_DATA_DIR (the desktop app points this at the per-user app-data folder),
// otherwise the project root, exactly as before.
const dataDir = process.env.RETROTV_DATA_DIR || path.join(__dirname, '..');
fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, 'yt_cable_tv.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
// SQLite ignores FOREIGN KEY / ON DELETE CASCADE unless this is switched on per connection
db.pragma('foreign_keys = ON');

// A video is unique per (YouTube channel key, video id), so the same video can be
// cached under two different keys (e.g. a handle and a UC... ID) without conflict.
function videosTableSql(name) {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yt_video_id TEXT NOT NULL,
      yt_channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      thumbnail_url TEXT,
      published_at TEXT,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (yt_channel_id, yt_video_id)
    )`;
}

// Initialize Database Tables
function initDatabase() {
  // 1. Profiles / Family Accounts (pin_code stores a bcrypt hash, never the raw PIN)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      avatar TEXT NOT NULL,
      pin_code TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Per-profile theme (JSON like {"preset":"80s","accent":"#ff3399"}); NULL = Classic
  try {
    db.prepare('ALTER TABLE profiles ADD COLUMN theme TEXT DEFAULT NULL').run();
  } catch (e) {
    // Column already exists
  }

  // 2. Custom Channels per Profile.
  //    (yt_channel_id is a legacy column: it mirrors the channel's first source.
  //     The real list of sources lives in channel_sources.)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      channel_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      yt_channel_id TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE
    )
  `).run();

  // 2b. A TV channel is made of one or more YouTube sources
  db.prepare(`
    CREATE TABLE IF NOT EXISTS channel_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      yt_channel_id TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE,
      UNIQUE (channel_id, yt_channel_id)
    )
  `).run();

  // 2c. YouTube channel titles (so an ungrouped channel gets a readable name, not a UC... ID)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS source_titles (
      yt_channel_id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    )
  `).run();

  // Migration: give every pre-existing channel its single source (only channels with none yet,
  // so sources you later remove never come back on restart)
  const migrated = db.prepare(`
    INSERT INTO channel_sources (channel_id, yt_channel_id)
    SELECT c.id, c.yt_channel_id FROM channels c
    WHERE c.yt_channel_id != ''
      AND NOT EXISTS (SELECT 1 FROM channel_sources s WHERE s.channel_id = c.id)
  `).run().changes;
  if (migrated > 0) console.log(`Migrated ${migrated} channel(s) to the multi-source layout.`);

  // 3. Cached YouTube Videos & Durations
  db.prepare(videosTableSql('videos')).run();

  // Auto-migration: ensure published_at exists if table was created previously
  try {
    db.prepare('ALTER TABLE videos ADD COLUMN published_at TEXT').run();
  } catch (e) {
    // Column already exists
  }

  // Migration: older databases had UNIQUE(yt_video_id) alone. Rebuild with the per-channel rule.
  const videosSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='videos'").get().sql;
  if (/yt_video_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(videosSql)) {
    db.transaction(() => {
      db.prepare(videosTableSql('videos_new')).run();
      db.prepare(`
        INSERT OR IGNORE INTO videos_new
          (yt_video_id, yt_channel_id, title, duration_seconds, thumbnail_url, published_at, cached_at)
        SELECT yt_video_id, yt_channel_id, title, duration_seconds, thumbnail_url, published_at, cached_at
        FROM videos
      `).run();
      db.prepare('DROP TABLE videos').run();
      db.prepare('ALTER TABLE videos_new RENAME TO videos').run();
    })();
    console.log('Migrated videos table to per-channel uniqueness.');
  }

  // Indexes: the EPG filters/sorts videos by channel + publish date on every request
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos (yt_channel_id, published_at)'
  ).run();

  // One channel number per profile. Wrapped in try/catch so an existing database
  // that already contains duplicates doesn't stop the server from starting.
  try {
    db.prepare(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_profile_number ON channels (profile_id, channel_number)'
    ).run();
  } catch (e) {
    console.warn('Could not enforce unique channel numbers (duplicates already exist):', e.message);
  }

  // Seed default profiles if none exist
  const count = db.prepare('SELECT COUNT(*) as count FROM profiles').get().count;
  if (count === 0) {
    const insertProfile = db.prepare('INSERT INTO profiles (name, avatar) VALUES (?, ?)');
    insertProfile.run('Dad', '👨‍💼');
    insertProfile.run('Mom', '👩‍💻');
    insertProfile.run('Kids', '🎮');
    console.log('Database initialized with default profiles: Dad, Mom, Kids');
  } else {
    console.log('Database connected and verified.');
  }
}

initDatabase();

module.exports = db;
