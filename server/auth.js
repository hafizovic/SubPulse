"use strict";
// Server-side Google sign-in (OAuth authorization-code flow with PKCE) and cookie sessions.
const crypto = require("crypto");
const config = require("./config");
const db = require("./db");

const YT_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
// "Manage your YouTube account" — only requested when the user first unsubscribes from a channel.
const MANAGE_SCOPE = "https://www.googleapis.com/auth/youtube";
const SCOPES = ["openid", YT_SCOPE];
const SESSION_COOKIE = "sp_session";
const STATE_COOKIE = "sp_oauth";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// In-memory access tokens (~1 hour each); the refresh token in the DB mints new ones.
const accessTokens = new Map();

const b64url = (buf) => buf.toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");

function reauthError() {
  const err = new Error("Your Google sign-in has expired. Please sign in again.");
  err.reauth = true;
  return err;
}

// ---------- Refresh-token encryption (AES-256-GCM) ----------

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.encryptionKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

// ---------- Cookies ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (config.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, "Set-Cookie": cookies });
  res.end();
}

// ---------- Google token endpoint ----------

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || `Token request failed (${res.status})`);
    err.oauthError = body.error;
    throw err;
  }
  return body;
}

function cacheAccessToken(userId, tokens) {
  accessTokens.set(userId, { token: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in) * 1000 });
}

async function getAccessToken(userId) {
  const cached = accessTokens.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const enc = await db.getRefreshToken(userId);
  if (!enc) throw reauthError();
  let refreshToken;
  try {
    refreshToken = decrypt(enc);
  } catch {
    throw reauthError(); // encryption key changed
  }
  try {
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    cacheAccessToken(userId, tokens);
    if (tokens.scope) await db.setUserScopes(userId, tokens.scope);
    return tokens.access_token;
  } catch (err) {
    if (err.oauthError === "invalid_grant") {
      // Revoked by the user, or expired (Testing-mode apps: after 7 days).
      await db.clearRefreshToken(userId);
      accessTokens.delete(userId);
      throw reauthError();
    }
    throw err;
  }
}

// ---------- Routes ----------

// upgrade: also ask for MANAGE_SCOPE. Consent is forced then, so Google issues a refresh
// token that covers the new scope.
function startLogin(res, { forceConsent = false, upgrade = false } = {}) {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: (upgrade ? [...SCOPES, MANAGE_SCOPE] : SCOPES).join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    state,
    code_challenge: sha256(verifier),
    code_challenge_method: "S256",
    ...(forceConsent || upgrade ? { prompt: "consent" } : {}),
  }).toString();
  redirect(res, url.toString(), [cookie(STATE_COOKIE, `${state}.${verifier}.${upgrade ? "manage" : ""}`, 600)]);
}

async function handleCallback(req, res, url) {
  const clearState = cookie(STATE_COOKIE, "", 0);
  const fail = (code) => redirect(res, `/?error=${code}`, [clearState]);

  const [state, verifier, mode] = (parseCookies(req)[STATE_COOKIE] || "").split(".");
  const upgrade = mode === "manage";
  const googleError = url.searchParams.get("error");
  if (googleError) return fail(googleError === "access_denied" ? "access_denied" : "oauth_error");
  if (!state || !verifier || url.searchParams.get("state") !== state) return fail("state");

  let tokens;
  try {
    tokens = await tokenRequest({
      grant_type: "authorization_code",
      code: url.searchParams.get("code") || "",
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    });
  } catch (err) {
    console.error("OAuth code exchange failed:", err.message);
    return fail("oauth_error");
  }
  const granted = String(tokens.scope || "").split(" ");
  // The broader scope also allows reading, so either one is enough to use the app.
  if (!granted.includes(YT_SCOPE) && !granted.includes(MANAGE_SCOPE)) return fail("missing_scope");
  if (upgrade && !granted.includes(MANAGE_SCOPE)) return fail("manage_denied");

  // The ID token came straight from Google's token endpoint over TLS, so its claims can be
  // read without verifying the signature (per Google's OpenID Connect docs).
  let claims;
  try {
    claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return fail("oauth_error");
  }
  if (claims.aud !== config.googleClientId || !["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)) {
    return fail("oauth_error");
  }

  const user = await db.upsertUser(claims.sub, tokens.refresh_token ? encrypt(tokens.refresh_token) : null, granted.join(" "), Date.now());
  // Google only issues a refresh token on first consent; ask again if we don't have one.
  if (!user.hasRefreshToken) return startLogin(res, { forceConsent: true, upgrade });
  cacheAccessToken(user.id, tokens);

  const sessionId = b64url(crypto.randomBytes(32));
  await db.createSession(sha256(sessionId), user.id, Date.now() + SESSION_TTL_SEC * 1000);
  redirect(res, upgrade ? "/?resume=unsubscribe" : "/", [clearState, cookie(SESSION_COOKIE, sessionId, SESSION_TTL_SEC)]);
}

async function currentUserId(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  return sessionId ? db.getSessionUserId(sha256(sessionId), Date.now()) : null;
}

async function logout(req, res) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (sessionId) await db.deleteSession(sha256(sessionId));
  res.writeHead(204, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
  res.end();
}

// Revokes Google access and deletes everything stored about the user.
async function deleteAccount(userId, res) {
  const enc = await db.getRefreshToken(userId);
  if (enc) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: decrypt(enc) }),
      });
    } catch (err) {
      console.error("Token revoke failed (data is deleted anyway):", err.message);
    }
  }
  accessTokens.delete(userId);
  await db.deleteUser(userId);
  res.writeHead(204, { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
  res.end();
}

module.exports = { startLogin, handleCallback, currentUserId, logout, deleteAccount, getAccessToken, MANAGE_SCOPE };
