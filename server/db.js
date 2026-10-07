"use strict";
// All database access lives in this file. To move to Postgres or MySQL, reimplement these
// exported async functions with that driver — nothing else in the app touches SQL.
//
// The SQL is kept portable. Postgres differences, when porting:
//   - users.id: BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
//   - REAL -> DOUBLE PRECISION, INTEGER flags -> BOOLEAN
//   - placeholders: ? -> $1, $2, ...
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  google_sub        TEXT    NOT NULL UNIQUE,  -- Google account ID; no email or name is stored
  refresh_token_enc TEXT,                     -- AES-256-GCM encrypted
  scopes            TEXT,                     -- space-separated OAuth scopes the user granted
  created_at        BIGINT  NOT NULL,
  last_sync_at      BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT    PRIMARY KEY,             -- SHA-256 of the session cookie
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT  NOT NULL
);

-- Public channel data, shared by every user who follows the channel.
CREATE TABLE IF NOT EXISTS channels (
  id               TEXT   PRIMARY KEY,
  title            TEXT   NOT NULL,
  thumb            TEXT,
  updated_at       BIGINT NOT NULL,           -- last time any subscription list included it
  subscriber_count BIGINT,
  sample_size      INTEGER,
  last_upload_at   BIGINT,
  avg_gap_days     REAL,
  shorts_count     INTEGER,
  shorts_share     REAL,
  shorts_estimated INTEGER,
  avg_long_sec     REAL,
  avg_all_sec      REAL,
  no_uploads       INTEGER,
  fetched_at       BIGINT                     -- NULL until stats have been fetched
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  subscription_id TEXT,                       -- YouTube's ID for this subscription (needed to unsubscribe)
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_channel_idx ON subscriptions (channel_id);

-- YouTube API units used per quota day (the quota resets at midnight Pacific Time).
CREATE TABLE IF NOT EXISTS api_usage (
  day   TEXT    PRIMARY KEY,
  units INTEGER NOT NULL
);
`;

let db;
const statements = new Map();

function q(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

async function init(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate();
}

// Columns added after the first release; CREATE TABLE IF NOT EXISTS doesn't add them to old databases.
function migrate() {
  const addColumn = (table, column, type) => {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn("users", "scopes", "TEXT");
  addColumn("subscriptions", "subscription_id", "TEXT");
}

async function close() {
  statements.clear();
  db?.close();
  db = null;
}

// ---------- Users ----------

// A null refresh token keeps the stored one (Google only sends it on first consent).
async function upsertUser(googleSub, refreshTokenEnc, scopes, now) {
  const row = q(
    `INSERT INTO users (google_sub, refresh_token_enc, scopes, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (google_sub) DO UPDATE SET
       refresh_token_enc = COALESCE(excluded.refresh_token_enc, users.refresh_token_enc),
       scopes = excluded.scopes
     RETURNING id, refresh_token_enc`
  ).get(googleSub, refreshTokenEnc, scopes, now);
  return { id: row.id, hasRefreshToken: Boolean(row.refresh_token_enc) };
}

async function getUser(userId) {
  const row = q("SELECT id, last_sync_at, scopes FROM users WHERE id = ?").get(userId);
  return row ? { id: row.id, lastSyncAt: row.last_sync_at, scopes: (row.scopes || "").split(" ").filter(Boolean) } : null;
}

async function setUserScopes(userId, scopes) {
  q("UPDATE users SET scopes = ? WHERE id = ?").run(scopes, userId);
}

async function getRefreshToken(userId) {
  return q("SELECT refresh_token_enc FROM users WHERE id = ?").get(userId)?.refresh_token_enc || null;
}

async function clearRefreshToken(userId) {
  q("UPDATE users SET refresh_token_enc = NULL WHERE id = ?").run(userId);
}

async function setLastSync(userId, at) {
  q("UPDATE users SET last_sync_at = ? WHERE id = ?").run(at, userId);
}

// Cascades to the user's sessions and subscriptions.
async function deleteUser(userId) {
  tx(() => {
    q("DELETE FROM users WHERE id = ?").run(userId);
    q("DELETE FROM channels WHERE id NOT IN (SELECT channel_id FROM subscriptions)").run();
  });
}

// ---------- Sessions ----------

async function createSession(idHash, userId, expiresAt) {
  q("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)").run(idHash, userId, expiresAt);
}

async function getSessionUserId(idHash, now) {
  return q("SELECT user_id FROM sessions WHERE id_hash = ? AND expires_at > ?").get(idHash, now)?.user_id ?? null;
}

async function deleteSession(idHash) {
  q("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
}

async function deleteUserSessions(userId) {
  q("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

// ---------- Channels & subscriptions ----------

async function replaceSubscriptions(userId, subs, now) {
  tx(() => {
    q("DELETE FROM subscriptions WHERE user_id = ?").run(userId);
    for (const s of subs) {
      q(
        `INSERT INTO channels (id, title, thumb, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, thumb = excluded.thumb, updated_at = excluded.updated_at`
      ).run(s.id, s.title, s.thumb || null, now);
      q("INSERT INTO subscriptions (user_id, channel_id, subscription_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(
        userId,
        s.id,
        s.subscriptionId || null
      );
    }
  });
}

async function getSubscriptionId(userId, channelId) {
  return q("SELECT subscription_id FROM subscriptions WHERE user_id = ? AND channel_id = ?").get(userId, channelId)?.subscription_id || null;
}

async function removeSubscription(userId, channelId) {
  tx(() => {
    q("DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?").run(userId, channelId);
    q("DELETE FROM channels WHERE id = ? AND id NOT IN (SELECT channel_id FROM subscriptions)").run(channelId);
  });
}

// The user's channels whose stats are missing or older than `freshAfter`.
async function channelsNeedingStats(userId, freshAfter) {
  return q(
    `SELECT c.id FROM subscriptions s JOIN channels c ON c.id = s.channel_id
     WHERE s.user_id = ? AND (c.fetched_at IS NULL OR c.fetched_at < ?)`
  )
    .all(userId, freshAfter)
    .map((r) => r.id);
}

async function saveChannelStats(channelId, s, now) {
  q(
    `UPDATE channels SET subscriber_count = ?, sample_size = ?, last_upload_at = ?, avg_gap_days = ?,
       shorts_count = ?, shorts_share = ?, shorts_estimated = ?, avg_long_sec = ?, avg_all_sec = ?,
       no_uploads = ?, fetched_at = ?
     WHERE id = ?`
  ).run(
    s.subscriberCount ?? null,
    s.sampleSize ?? null,
    s.lastUpload ?? null,
    s.avgGapDays ?? null,
    s.shortsCount ?? null,
    s.shortsShare ?? null,
    s.shortsEstimated ? 1 : 0,
    s.avgLongSec ?? null,
    s.avgAllSec ?? null,
    s.empty ? 1 : 0,
    now,
    channelId
  );
}

async function getUserStats(userId) {
  return q(
    `SELECT c.* FROM subscriptions s JOIN channels c ON c.id = s.channel_id
     WHERE s.user_id = ? ORDER BY c.title`
  )
    .all(userId)
    .map((c) => ({
      id: c.id,
      title: c.title,
      thumb: c.thumb,
      subscriberCount: c.subscriber_count,
      sampleSize: c.sample_size,
      lastUpload: c.last_upload_at,
      avgGapDays: c.avg_gap_days,
      shortsCount: c.shorts_count,
      shortsShare: c.shorts_share,
      shortsEstimated: Boolean(c.shorts_estimated),
      avgLongSec: c.avg_long_sec,
      avgAllSec: c.avg_all_sec,
      empty: Boolean(c.no_uploads),
      fetchedAt: c.fetched_at,
    }));
}

// ---------- Quota ----------

async function addUnits(day, units) {
  q(
    `INSERT INTO api_usage (day, units) VALUES (?, ?)
     ON CONFLICT (day) DO UPDATE SET units = api_usage.units + excluded.units`
  ).run(day, units);
}

async function getUnits(day) {
  return q("SELECT units FROM api_usage WHERE day = ?").get(day)?.units ?? 0;
}

// ---------- Retention ----------

// Removes YouTube data older than the policy limit, orphaned channels and expired sessions.
async function purge(cutoff, now) {
  tx(() => {
    q("DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE last_sync_at < ?)").run(cutoff);
    q("DELETE FROM channels WHERE updated_at < ? OR id NOT IN (SELECT channel_id FROM subscriptions)").run(cutoff);
    q("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  });
}

module.exports = {
  init,
  close,
  upsertUser,
  getUser,
  setUserScopes,
  getRefreshToken,
  clearRefreshToken,
  setLastSync,
  deleteUser,
  createSession,
  getSessionUserId,
  deleteSession,
  deleteUserSessions,
  replaceSubscriptions,
  getSubscriptionId,
  removeSubscription,
  channelsNeedingStats,
  saveChannelStats,
  getUserStats,
  addUnits,
  getUnits,
  purge,
};
