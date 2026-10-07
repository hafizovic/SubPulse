"use strict";
// YouTube Data API v3 calls and per-channel analysis.
const API = "https://www.googleapis.com/youtube/v3/";
const SAMPLE = 50; // uploads analyzed per channel (API max per page)
const DAY = 24 * 60 * 60 * 1000;
const UNSUBSCRIBE_COST = 50;

class YouTubeError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Errors that should stop the whole sync rather than just one channel.
function isFatal(err) {
  return (
    err.reauth ||
    err.status === 401 ||
    ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "accessNotConfigured"].includes(err.reason)
  );
}

// onUnits(n) is called before each request with its quota cost.
function client(accessToken, onUnits) {
  async function api(endpoint, params, { method = "GET", cost = 1 } = {}) {
    const url = new URL(API + endpoint);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    onUnits(cost);
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      let reason = "";
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        reason = body.error?.errors?.[0]?.reason || "";
        message = body.error?.message || message;
      } catch {}
      throw new YouTubeError(message, res.status, reason);
    }
    return res.status === 204 ? null : res.json();
  }

  async function fetchSubscriptions() {
    const subs = [];
    let pageToken;
    do {
      const data = await api("subscriptions", { part: "snippet", mine: "true", maxResults: 50, order: "alphabetical", pageToken });
      for (const item of data.items || []) {
        subs.push({
          subscriptionId: item.id,
          id: item.snippet.resourceId.channelId,
          title: item.snippet.title,
          thumb: item.snippet.thumbnails?.default?.url || "",
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return subs;
  }

  async function fetchChannelInfo(ids) {
    const info = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const data = await api("channels", { part: "contentDetails,statistics", id: ids.slice(i, i + 50).join(","), maxResults: 50 });
      for (const c of data.items || []) {
        info.set(c.id, {
          uploads: c.contentDetails?.relatedPlaylists?.uploads,
          subscriberCount: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount),
        });
      }
    }
    return info;
  }

  // Returns [{id, publishedAt}] or null when the playlist doesn't exist.
  async function playlistVideos(playlistId) {
    try {
      const data = await api("playlistItems", { part: "contentDetails", playlistId, maxResults: SAMPLE });
      return (data.items || [])
        .filter((i) => i.contentDetails?.videoPublishedAt) // skips private/deleted videos
        .map((i) => ({ id: i.contentDetails.videoId, publishedAt: i.contentDetails.videoPublishedAt }));
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async function analyzeChannel(channelId, info) {
    const base = { subscriberCount: info?.subscriberCount ?? null };
    const uploads = info?.uploads ? (await playlistVideos(info.uploads)) || [] : [];
    if (!uploads.length) return { ...base, empty: true };

    // Undocumented but widely used: "UUSH" + channel suffix = the channel's Shorts playlist.
    const [shortsList, details] = await Promise.all([
      playlistVideos("UUSH" + channelId.slice(2)),
      api("videos", { part: "contentDetails", id: uploads.map((v) => v.id).join(","), maxResults: SAMPLE }),
    ]);
    const durations = new Map((details.items || []).map((v) => [v.id, parseDuration(v.contentDetails?.duration)]));
    const shortIds = shortsList ? new Set(shortsList.map((v) => v.id)) : null;

    const videos = uploads.map((v) => {
      const duration = durations.get(v.id) ?? 0;
      const isShort = shortIds ? shortIds.has(v.id) : duration > 0 && duration <= 60;
      return { ...v, duration, isShort };
    });

    const times = videos.map((v) => Date.parse(v.publishedAt)).sort((a, b) => b - a);
    const shorts = videos.filter((v) => v.isShort);
    const longs = videos.filter((v) => !v.isShort && v.duration > 0);
    const timed = videos.filter((v) => v.duration > 0);

    return {
      ...base,
      sampleSize: videos.length,
      lastUpload: times[0],
      avgGapDays: times.length > 1 ? (times[0] - times[times.length - 1]) / DAY / (times.length - 1) : null,
      shortsCount: shorts.length,
      shortsShare: shorts.length / videos.length,
      shortsEstimated: !shortIds,
      avgLongSec: longs.length ? mean(longs.map((v) => v.duration)) : null,
      avgAllSec: timed.length ? mean(timed.map((v) => v.duration)) : null,
    };
  }

  // For subscriptions synced before subscription IDs were stored.
  async function findSubscriptionId(channelId) {
    const data = await api("subscriptions", { part: "id", mine: "true", forChannelId: channelId, maxResults: 1 });
    return data.items?.[0]?.id || null;
  }

  // Costs 50 units. A 404 means it's already gone, which counts as success.
  async function unsubscribe(subscriptionId) {
    try {
      await api("subscriptions", { id: subscriptionId }, { method: "DELETE", cost: UNSUBSCRIBE_COST });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  return { fetchSubscriptions, fetchChannelInfo, analyzeChannel, findSubscriptionId, unsubscribe };
}

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || "");
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

module.exports = { client, isFatal, YouTubeError, parseDuration, UNSUBSCRIBE_COST };
