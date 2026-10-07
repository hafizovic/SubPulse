"use strict";
// Reads settings from .env (real environment variables win) and prepares the encryption key.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env"));

const env = process.env;
const port = Number(env.PORT) || 5173;
const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const dataDir = path.resolve(ROOT, env.DATA_DIR || "data");

// Encrypts stored Google refresh tokens. Generated once and kept in data/ unless set in .env.
// Losing it only means everyone has to sign in again.
function loadEncryptionKey() {
  if (env.ENCRYPTION_KEY) {
    const key = Buffer.from(env.ENCRYPTION_KEY, "base64");
    if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
    return key;
  }
  const file = path.join(dataDir, "encryption.key");
  try {
    return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
    return key;
  }
}

module.exports = {
  root: ROOT,
  publicDir: path.join(ROOT, "public"),
  port,
  baseUrl,
  redirectUri: `${baseUrl}/auth/callback`,
  googleClientId: (env.GOOGLE_CLIENT_ID || "").trim(),
  googleClientSecret: (env.GOOGLE_CLIENT_SECRET || "").trim(),
  get configured() {
    return Boolean(this.googleClientId && this.googleClientSecret);
  },
  dbPath: path.resolve(ROOT, env.DATABASE_PATH || path.join(dataDir, "subpulse.db")),
  encryptionKey: loadEncryptionKey(),
  secureCookies: baseUrl.startsWith("https://"),
  // Channel stats fetched by anyone within this window are reused instead of re-fetched.
  channelTtlMs: (Number(env.CHANNEL_TTL_HOURS) || 6) * 60 * 60 * 1000,
  // YouTube API data may be stored for at most 30 days.
  maxDataAgeMs: 30 * 24 * 60 * 60 * 1000,
  quotaLimit: Number(env.YOUTUBE_DAILY_QUOTA) || 10000,
};
