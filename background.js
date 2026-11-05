importScripts("confluence.js");

const REFRESH_MINUTES = 5;
const REFRESH_MS = REFRESH_MINUTES * 60 * 1000;
const ALARM_NAME = "confluence-refresh";
const store = chrome.storage.local;
let queue = Promise.resolve();
let refreshJob = null;

function enqueue(operation) {
  const job = queue.then(operation);
  queue = job.catch(() => {});
  return job;
}
function credentialsEqual(a, b) {
  return a?.host === b?.host && a?.email === b?.email && a?.token === b?.token;
}
function configured(settings) { return Boolean(settings?.host && settings.email && settings.token); }
async function ensureAlarm() {
  const { settings } = await store.get("settings");
  if (!configured(settings)) { await chrome.alarms.clear(ALARM_NAME); return; }
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm || alarm.periodInMinutes !== REFRESH_MINUTES) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: REFRESH_MINUTES, periodInMinutes: REFRESH_MINUTES });
  }
}
function newClient(settings, cache) {
  const state = { settings, me: null, comments: [], pages: new Map(), users: new Map(), originals: new Map() };
  const client = createConfluenceClient(state);
  client.restore(cache);
  if (!state.metadataAt || Date.now() - state.metadataAt > 60 * 60 * 1000) {
    state.pages.clear(); state.users.clear(); state.metadataAt = Date.now();
  }
  return { state, client };
}
async function checkPermission(settings) {
  if (!await chrome.permissions.contains({ origins: [`${new URL(settings.host).origin}/*`] })) {
    throw Object.assign(new Error("permissionDenied"), { status: 403 });
  }
}
async function saveIfCurrent(settings, values) {
  const current = await store.get("settings");
  if (!credentialsEqual(settings, current.settings)) throw new Error("settingsChanged");
  await store.set(values);
}
async function refreshNow(force) {
  const { settings, commentCache, syncStatus } = await store.get(["settings", "commentCache", "syncStatus"]);
  if (!configured(settings)) throw new Error("configure");
  await checkPermission(settings);
  if (!force && syncStatus?.state !== "error" && matchesConfluenceCache(commentCache, settings) && Date.now() - Date.parse(commentCache.updatedAt) < REFRESH_MS) {
    await store.set({ syncStatus: { host: settings.host, email: settings.email, state: "idle" } });
    return commentCache;
  }
  const scope = { host: settings.host, email: settings.email };
  await store.set({ syncStatus: { ...scope, state: "syncing" } });
  try {
    const { state, client } = newClient(settings, commentCache);
    const me = await client.api("/wiki/rest/api/user/current");
    if (!me?.accountId) throw new Error("authFailed");
    if (state.me && state.me.accountId !== me.accountId) {
      state.comments = []; state.pages.clear(); state.users.clear(); state.originals.clear();
    }
    state.me = me;
    await saveIfCurrent(settings, { syncStatus: { ...scope, state: "syncing", me } });
    const context = client.createCommentLoadContext();
    const sources = Object.entries(client.commentSources);
    const results = await Promise.allSettled(sources.map(([, source]) => source.load(context)));
    const failed = results.filter(result => result.status === "rejected");
    const authError = failed.find(result => result.reason.status === 401);
    if (authError) throw authError.reason;
    if (failed.length === results.length) throw failed[0].reason;
    state.comments = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const kind = sources[index][0];
      context.warnings.add(`${kind === "inline" ? "Inline" : "Page"}: ${result.reason.message}`);
      return state.comments.filter(item => item.kind === kind);
    }).filter(item => item.mine || item.watched)
      .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    state.lastUpdated = new Date();
    const cache = client.snapshot([...context.warnings]);
    await saveIfCurrent(settings, { commentCache: cache, syncStatus: { ...scope, state: "idle" } });
    return cache;
  } catch (error) {
    const current = await store.get("settings");
    if (credentialsEqual(settings, current.settings)) {
      if (error.status === 401) await store.remove("commentCache");
      await store.set({ syncStatus: { ...scope, state: "error", status: error.status, message: error.message } });
    }
    throw error;
  }
}
function refresh(force = false) {
  if (refreshJob) return refreshJob;
  const job = enqueue(() => refreshNow(force));
  refreshJob = job;
  job.finally(() => { if (refreshJob === job) refreshJob = null; }).catch(() => {});
  return job;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")) || message?.type !== "confluence") return false;
  const job = message.action === "refresh" ? refresh(Boolean(message.force))
    : Promise.reject(new Error("readOnly"));
  job.then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: { message: error.message, status: error.status } }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) refresh(true).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => { ensureAlarm().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm().then(() => refresh()).catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  ensureAlarm().catch(console.error);
  if (!credentialsEqual(changes.settings.oldValue, changes.settings.newValue)) {
    // The account cache is never reused across credential changes.
    queue.then(() => refresh(true)).catch(() => {});
  }
});
// Recreate alarms if the browser dropped them while the worker was stopped.
ensureAlarm().catch(console.error);
