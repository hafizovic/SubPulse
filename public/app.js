"use strict";
// Frontend: talks only to the SubPulse server, which handles Google sign-in and YouTube.

const DAY = 24 * 60 * 60 * 1000;
const POLL_MS = 1000;

const state = {
  rows: [],
  sort: { key: "daysSince", asc: true },
  filter: "all",
  query: "",
  lastSync: null,
  quota: null,
  canUnsubscribe: false,
};

const PENDING_UNSUB_KEY = "subpulse:pendingUnsubscribe";

const $ = (id) => document.getElementById(id);

const SIGN_IN_ERRORS = {
  access_denied: "Sign-in was cancelled.",
  missing_scope: "Please allow “View your YouTube account” when signing in — the app can't work without it.",
  state: "Sign-in expired or was started in another tab. Please try again.",
  oauth_error: "Google sign-in failed. Please try again.",
  manage_denied: "Unsubscribing needs the “Manage your YouTube account” permission. Nothing was changed.",
};

class SignedOutError extends Error {}

// ---------- Server API ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Accept: "application/json", ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401) {
    showView("welcome");
    throw new SignedOutError("Please sign in again.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.message || `Server error (${res.status})`), { code: data?.error });
  return data;
}

async function refreshMe() {
  const me = await api("GET", "/api/me");
  state.lastSync = me.lastSyncAt;
  state.quota = me.quota;
  state.canUnsubscribe = Boolean(me.canUnsubscribe);
  return me;
}

async function loadStats() {
  const { rows } = await api("GET", "/api/stats");
  state.rows = rows;
  render();
}

// ---------- Unsubscribe ----------

function readPending() {
  try {
    const id = sessionStorage.getItem(PENDING_UNSUB_KEY);
    sessionStorage.removeItem(PENDING_UNSUB_KEY);
    return id;
  } catch {
    return null;
  }
}

// One-time trip to Google to grant "Manage your YouTube account"; resumes afterwards.
function requestManagePermission(channelId) {
  const ok = confirm(
    "To unsubscribe, SubPulse needs one extra permission from Google: “Manage your YouTube account”.\n\n" +
      "You'll be sent to Google once to allow it, then brought back here."
  );
  if (!ok) return;
  try {
    sessionStorage.setItem(PENDING_UNSUB_KEY, channelId);
  } catch {}
  location.href = "/auth/login?upgrade=manage";
}

async function unsubscribe(channelId) {
  const row = state.rows.find((r) => r.id === channelId);
  if (!row) return;
  if (!state.canUnsubscribe) return requestManagePermission(channelId);
  if (!confirm(`Unsubscribe from “${row.title}” on YouTube?\n\nTo undo it, you'd have to subscribe again on YouTube.`)) return;

  hideError();
  const btn = document.querySelector(`[data-unsub="${CSS.escape(channelId)}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Unsubscribing…";
  }
  try {
    await api("POST", "/api/unsubscribe", { channelId });
    state.rows = state.rows.filter((r) => r.id !== channelId);
    showInfo(`Unsubscribed from “${row.title}”.`);
    await refreshMe();
  } catch (err) {
    if (err.code === "needs_permission") {
      state.canUnsubscribe = false;
      requestManagePermission(channelId);
    } else if (!(err instanceof SignedOutError)) {
      showError(err.message);
    }
  }
  render();
}

async function startSync() {
  hideError();
  $("syncBtn").disabled = true;
  try {
    const { job } = await api("POST", "/api/sync");
    await followSync(job);
  } catch (err) {
    showError(err.message);
  } finally {
    $("syncBtn").disabled = false;
  }
}

// Polls the server-side sync job until it finishes, refreshing the table along the way.
async function followSync(job) {
  $("syncBtn").disabled = true;
  let polls = 0;
  while (job?.running) {
    setStatus(
      job.phase === "subscriptions"
        ? "Loading your subscriptions…"
        : `Analyzing channels… ${job.done} / ${job.total}${job.reused ? ` (${job.reused} already up to date)` : ""}`,
      job.total ? job.done / job.total : 0
    );
    await new Promise((r) => setTimeout(r, POLL_MS));
    ({ job } = await api("GET", "/api/sync"));
    if (++polls % 3 === 0) await loadStats();
  }
  hideStatus();
  $("syncBtn").disabled = false;
  await refreshMe();
  await loadStats();
  if (job?.reauth) {
    await api("POST", "/auth/logout");
    showView("welcome");
    showError(job.error);
  } else if (job?.error) {
    showError(job.error);
  } else if (job?.failed) {
    showError(`${job.failed} channel(s) couldn't be loaded this time — try syncing again later.`);
  }
}

// ---------- Rendering ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function daysSince(row) {
  return row.lastUpload ? (Date.now() - row.lastUpload) / DAY : null;
}

function fmtAgo(days) {
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 60) return `${Math.floor(days)} days ago`;
  if (days < 730) return `${Math.floor(days / 30.4)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function fmtFrequency(gap) {
  if (gap == null) return "—";
  if (gap < 1) return `${(1 / Math.max(gap, 0.05)).toFixed(1)}× per day`;
  if (gap <= 7) return `${(7 / gap).toFixed(1)}× per week`;
  if (gap <= 45) return `every ~${Math.round(gap)} days`;
  return `every ~${(gap / 30.4).toFixed(1)} months`;
}

function fmtDuration(sec) {
  if (sec == null) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function fmtCount(n) {
  if (n == null || Number.isNaN(n)) return "";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function mixLabel(share) {
  if (share >= 0.6) return "Mostly Shorts";
  if (share <= 0.4) return "Mostly videos";
  return "Mixed";
}

function matchesFilter(row) {
  const d = daysSince(row);
  switch (state.filter) {
    case "active7": return d != null && d < 7;
    case "inactive30": return d != null && d >= 30;
    case "inactive180": return d != null && d >= 180;
    case "shorts": return row.shortsShare != null && row.shortsShare >= 0.6;
    case "videos": return row.shortsShare != null && row.shortsShare <= 0.4;
    default: return true;
  }
}

function sortValue(row, key) {
  if (key === "title") return row.title.toLowerCase();
  if (key === "daysSince") return daysSince(row);
  return row[key];
}

function sortedRows() {
  const { key, asc } = state.sort;
  const q = state.query.trim().toLowerCase();
  return state.rows
    .filter((r) => (!q || r.title.toLowerCase().includes(q)) && matchesFilter(r))
    .sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va == null && vb == null) return a.title.localeCompare(b.title);
      if (va == null) return 1; // missing values always last
      if (vb == null) return -1;
      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return asc ? cmp : -cmp;
    });
}

function renderRow(r) {
  const channel = `
    <div class="channel">
      ${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="avatar"></span>'}
      <div>
        <a href="https://www.youtube.com/channel/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.title)}</a>
        ${r.subscriberCount != null ? `<div class="sub">${fmtCount(r.subscriberCount)} subscribers</div>` : ""}
      </div>
    </div>`;

  const actions = `<td class="actions"><button class="btn btn-small" data-unsub="${esc(r.id)}">Unsubscribe</button></td>`;

  if (r.fetchedAt == null) return `<tr><td>${channel}</td><td colspan="4" class="muted small">Not analyzed yet — click Sync</td>${actions}</tr>`;
  if (r.empty) return `<tr><td>${channel}</td><td colspan="4" class="muted small">No public uploads</td>${actions}</tr>`;

  const d = daysSince(r);
  const tone = d < 7 ? "good" : d < 30 ? "warn" : "bad";
  const pctShorts = Math.round(r.shortsShare * 100);
  const longCount = r.sampleSize - r.shortsCount;

  return `<tr>
    <td>${channel}</td>
    <td>
      <span class="badge ${tone}" title="${esc(new Date(r.lastUpload).toLocaleString())}">${fmtAgo(d)}</span>
    </td>
    <td>
      ${fmtFrequency(r.avgGapDays)}
      <div class="sub">based on last ${r.sampleSize} uploads</div>
    </td>
    <td class="mix">
      <div class="mix-bar" title="${r.shortsCount} Shorts · ${longCount} videos">
        <div class="s" style="width:${pctShorts}%"></div><div class="v" style="width:${100 - pctShorts}%"></div>
      </div>
      <div class="mix-label">${mixLabel(r.shortsShare)} <span class="sub">${pctShorts}% Shorts</span>
        ${r.shortsEstimated ? '<span class="est" title="Estimated by duration (≤60s)">est.</span>' : ""}</div>
    </td>
    <td>
      ${fmtDuration(r.avgLongSec)}
      <div class="sub">all uploads: ${fmtDuration(r.avgAllSec)}</div>
    </td>
    ${actions}
  </tr>`;
}

function renderSummary() {
  const ready = state.rows.filter((r) => r.lastUpload);
  const count = (fn) => ready.filter(fn).length;
  const stats = [
    [state.rows.length, "Subscriptions"],
    [count((r) => daysSince(r) < 7), "Posted this week"],
    [count((r) => daysSince(r) >= 30), "Inactive 30+ days"],
    [count((r) => r.shortsShare >= 0.6), "Mostly Shorts"],
  ];
  $("summary").innerHTML = stats
    .map(([v, l]) => `<div class="stat"><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`)
    .join("");
}

function render() {
  renderSummary();
  const rows = sortedRows();
  $("rows").innerHTML = rows.length
    ? rows.map(renderRow).join("")
    : `<tr><td colspan="6" class="empty">${
        state.rows.length ? "No channels match."
        : state.lastSync ? "You're not subscribed to any channels yet."
        : "Nothing synced yet — click <strong>Sync</strong> to load your subscriptions."
      }</td></tr>`;
  $("lastSync").textContent = state.lastSync ? `Synced ${fmtAgo((Date.now() - state.lastSync) / DAY)}` : "Not synced yet";
  $("quota").textContent = state.quota ? `API quota today: ${state.quota.used.toLocaleString()} / ${state.quota.limit.toLocaleString()}` : "";
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === state.sort.key;
    th.classList.toggle("sorted", active);
    th.classList.toggle("asc", active && state.sort.asc);
  });
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---------- View helpers ----------

function showView(name) {
  for (const id of ["setup", "welcome", "dashboard"]) $(id).hidden = id !== name;
  const signedIn = name === "dashboard";
  for (const id of ["syncBtn", "signOutBtn", "quota", "lastSync"]) $(id).hidden = !signedIn;
  if (!signedIn) hideStatus();
}

function setStatus(text, fraction) {
  $("status").hidden = false;
  $("statusText").textContent = text;
  $("progressBar").style.width = `${Math.round(fraction * 100)}%`;
}
function hideStatus() {
  $("status").hidden = true;
}
function showError(msg) {
  $("error").textContent = msg;
  $("error").hidden = false;
}
function hideError() {
  $("error").hidden = true;
  $("info").hidden = true;
}
function showInfo(msg) {
  $("info").textContent = msg;
  $("info").hidden = false;
}

// ---------- Init ----------

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has("error")) {
    if (params.get("error") === "manage_denied") readPending();
    showError(SIGN_IN_ERRORS[params.get("error")] || SIGN_IN_ERRORS.oauth_error);
    history.replaceState(null, "", "/");
  }

  $("syncBtn").addEventListener("click", startSync);
  $("rows").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-unsub]");
    if (btn) unsubscribe(btn.dataset.unsub);
  });
  $("signOutBtn").addEventListener("click", async () => {
    await api("POST", "/auth/logout");
    state.rows = [];
    showView("welcome");
  });
  $("deleteBtn").addEventListener("click", async () => {
    if (!confirm("Disconnect your Google account and permanently delete all your data from SubPulse?")) return;
    try {
      await api("POST", "/api/account/delete");
      state.rows = [];
      showView("welcome");
    } catch (err) {
      showError(err.message);
    }
  });
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value;
    render();
  });
  $("filter").addEventListener("change", (e) => {
    state.filter = e.target.value;
    render();
  });
  document.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = state.sort.key === key ? { key, asc: !state.sort.asc } : { key, asc: key === "title" || key === "daysSince" };
      render();
    })
  );

  try {
    const me = await refreshMe();
    if (!me.configured) return showView("setup");
    if (!me.signedIn) return showView("welcome");
    showView("dashboard");
    await loadStats();
    const { job } = await api("GET", "/api/sync");
    // Back from granting the unsubscribe permission: continue where the user left off.
    const pending = readPending();
    if (params.get("resume") === "unsubscribe") history.replaceState(null, "", "/");
    if (pending && state.canUnsubscribe) await unsubscribe(pending);
    if (job?.running) await followSync(job); // a sync started before the reload is still going
  } catch (err) {
    if (!(err instanceof SignedOutError)) showError(`Can't reach the SubPulse server: ${err.message}`);
  }
}

init();
