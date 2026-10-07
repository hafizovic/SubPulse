"use strict";
// Runs a user's sync in the background and tracks its progress.
const config = require("./config");
const db = require("./db");
const auth = require("./auth");
const youtube = require("./youtube");

const CONCURRENCY = 6;
const jobs = new Map(); // userId -> job
const inflight = new Map(); // channelId -> promise; stops two users' syncs fetching the same channel at once

// YouTube's quota day resets at midnight Pacific Time.
function quotaDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(date);
}

function getJob(userId) {
  const job = jobs.get(userId);
  return job ? { ...job } : null;
}

function startSync(userId) {
  const existing = jobs.get(userId);
  if (existing?.running) return { ...existing };
  const job = { running: true, phase: "subscriptions", done: 0, total: 0, failed: 0, reused: 0, error: null, reauth: false };
  jobs.set(userId, job);
  run(userId, job);
  return { ...job };
}

async function run(userId, job) {
  try {
    if ((await db.getUnits(quotaDay())) >= config.quotaLimit) {
      throw Object.assign(new Error("quota"), { reason: "quotaExceeded" });
    }
    const token = await auth.getAccessToken(userId);
    const yt = youtube.client(token, (n) => db.addUnits(quotaDay(), n));

    const subs = await yt.fetchSubscriptions();
    const now = Date.now();
    await db.replaceSubscriptions(userId, subs, now);

    // Channels someone synced within the TTL are reused — this is the shared cache.
    const ids = await db.channelsNeedingStats(userId, now - config.channelTtlMs);
    job.reused = subs.length - ids.length;
    job.phase = "channels";
    job.total = ids.length;

    const info = ids.length ? await yt.fetchChannelInfo(ids) : new Map();
    await mapLimit(ids, CONCURRENCY, async (id) => {
      try {
        await analyzeOnce(id, () => yt.analyzeChannel(id, info.get(id)));
      } catch (err) {
        if (youtube.isFatal(err)) throw err;
        console.error(`Channel ${id} failed:`, err.message);
        job.failed++;
      }
      job.done++;
    });
    await db.setLastSync(userId, Date.now());
  } catch (err) {
    job.reauth = Boolean(err.reauth);
    job.error = describeError(err);
    if (!job.reauth && !youtube.isFatal(err)) console.error("Sync failed:", err);
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    await db.purge(Date.now() - config.maxDataAgeMs, Date.now()).catch((e) => console.error("Purge failed:", e));
  }
}

// Returns { status, body } for the HTTP route.
async function unsubscribe(userId, channelId) {
  const user = await db.getUser(userId);
  if (!user.scopes.includes(auth.MANAGE_SCOPE)) return { status: 403, body: { error: "needs_permission" } };
  if ((await db.getUnits(quotaDay())) + youtube.UNSUBSCRIBE_COST > config.quotaLimit) {
    return { status: 429, body: { error: "quota", message: "Not enough YouTube API quota left today (unsubscribing costs 50 units)." } };
  }
  try {
    const yt = youtube.client(await auth.getAccessToken(userId), (n) => db.addUnits(quotaDay(), n));
    const subscriptionId = (await db.getSubscriptionId(userId, channelId)) || (await yt.findSubscriptionId(channelId));
    if (subscriptionId) await yt.unsubscribe(subscriptionId);
    await db.removeSubscription(userId, channelId);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    if (err.reauth) return { status: 401, body: { error: "signed_out", message: err.message } };
    if (err.status === 403 && ["insufficientPermissions", "forbidden"].includes(err.reason)) {
      return { status: 403, body: { error: "needs_permission" } };
    }
    console.error("Unsubscribe failed:", err);
    return { status: 502, body: { error: "youtube", message: describeError(err).replace(/^Sync failed: /, "Unsubscribe failed: ") } };
  }
}

function analyzeOnce(channelId, analyze) {
  if (!inflight.has(channelId)) {
    const p = analyze()
      .then((stats) => db.saveChannelStats(channelId, stats, Date.now()))
      .finally(() => inflight.delete(channelId));
    inflight.set(channelId, p);
  }
  return inflight.get(channelId);
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  let aborted = null;
  const worker = async () => {
    while (next < items.length && !aborted) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        aborted = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (aborted) throw aborted;
}

function describeError(err) {
  if (err.reauth) return err.message;
  if (err.status === 401) return "Google rejected the access token. Please sign in again.";
  if (err.reason === "quotaExceeded" || err.reason === "dailyLimitExceeded")
    return "The YouTube API daily quota is used up. It resets at midnight Pacific Time — channels that finished were saved.";
  if (err.reason === "rateLimitExceeded") return "YouTube is rate-limiting requests. Wait a minute and sync again.";
  if (err.reason === "accessNotConfigured")
    return "YouTube Data API v3 is not enabled for this Google Cloud project. Enable it in the Cloud Console and try again.";
  return `Sync failed: ${err.message}`;
}

module.exports = { startSync, getJob, unsubscribe, quotaDay };
