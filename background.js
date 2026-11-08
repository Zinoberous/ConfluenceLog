importScripts("confluence.js");

const REFRESH_MINUTES = 0.5;
const REFRESH_MS = 5 * 60 * 1000; // Opening a fresh cache need not start a duplicate scan.
const ALARM_NAME = "confluence-refresh";
const store = chrome.storage.local;
let queue = Promise.resolve();
let refreshJob = null;
let continuationTimer;

function enqueue(operation) {
  const job = queue.then(operation);
  queue = job.catch(() => {});
  return job;
}
function credentialsEqual(a, b) {
  return a?.host === b?.host && a?.email === b?.email && a?.token === b?.token;
}
function configured(settings) { return Boolean(settings?.host && settings.email && settings.token); }
function countOpenItems(state, client) {
  const tasks = state.tasks.filter(task => task.body ? client.bodyText(task.body, task.assignedTo) : task.text?.trim());
  return tasks.length + state.comments.filter(item => item.open && (item.mine || item.watched)).length;
}
async function updateBadge() {
  const { settings, commentCache } = await store.get(["settings", "commentCache"]);
  let count = 0;
  if (configured(settings) && matchesConfluenceCache(commentCache, settings)) {
    count = commentCache.openCount;
    if (count === undefined) {
      const { state, client } = newClient(settings, commentCache);
      count = countOpenItems(state, client);
    }
  }
  await chrome.action.setBadgeText({ text: count > 999 ? "999+" : count ? String(count) : "" });
}
async function ensureAlarm() {
  const { settings } = await store.get("settings");
  if (!configured(settings)) { await chrome.alarms.clear(ALARM_NAME); return; }
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm || alarm.periodInMinutes !== REFRESH_MINUTES) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: REFRESH_MINUTES, periodInMinutes: REFRESH_MINUTES });
  }
}
function armLoop(delay = 0) {
  clearTimeout(continuationTimer);
  continuationTimer = setTimeout(() => resumeLoop().catch(console.error), Math.max(0, delay));
}
async function resumeLoop() {
  const { settings, syncControl } = await store.get(["settings", "syncControl"]);
  if (!configured(settings) || syncControl?.blocked) return;
  if (syncControl?.nextAllowedAt > Date.now()) { armLoop(syncControl.nextAllowedAt - Date.now()); return; }
  await refresh(true).catch(() => {});
}
async function scheduleContinuation(error) {
  if (error?.message === "settingsChanged") { armLoop(); return; }
  const { settings, syncControl } = await store.get(["settings", "syncControl"]);
  if (!configured(settings)) return;
  if (error?.cooldown) { if (error.retryAfterMs) armLoop(error.retryAfterMs); return; }
  const blocked = error?.status === 401 || error?.status === 403 || error?.message === "authFailed";
  const failures = error ? (syncControl?.failures ?? 0) + 1 : 0;
  const delay = error ? Math.max(error.retryAfterMs ?? 0, Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4))) : 0;
  await store.set({ syncControl: { blocked, failures, nextAllowedAt: Date.now() + delay } });
  if (!blocked) armLoop(delay);
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
  const { settings, commentCache, syncStatus, syncControl } = await store.get(["settings", "commentCache", "syncStatus", "syncControl"]);
  if (!configured(settings)) throw new Error("configure");
  if (syncControl?.blocked) throw Object.assign(new Error("authFailed"), { status: 401, cooldown: true });
  if (syncControl?.nextAllowedAt > Date.now()) throw Object.assign(new Error("retryLater"), { cooldown: true, retryAfterMs: syncControl.nextAllowedAt - Date.now() });
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
      state.comments = []; state.tasks = []; state.tasksError = null; state.tasksUpdatedAt = null; state.pages.clear(); state.users.clear(); state.originals.clear();
    }
    state.me = me;
    await saveIfCurrent(settings, { syncStatus: { ...scope, state: "syncing", me } });
    const context = client.createCommentLoadContext();
    const sources = [...Object.entries(client.commentSources), ["tasks", { load: () => client.loadTasks() }]];
    const results = await Promise.allSettled(sources.map(([, source]) => source.load(context)));
    const failed = results.filter(result => result.status === "rejected");
    const authError = failed.find(result => result.reason.status === 401);
    if (authError) throw authError.reason;
    const throttled = failed.filter(result => result.reason.status === 429 || result.reason.status === 503)
      .sort((a,b) => (b.reason.retryAfterMs ?? 0) - (a.reason.retryAfterMs ?? 0))[0];
    if (throttled) throw throttled.reason;
    if (failed.length === results.length) throw failed[0].reason;
    state.comments = results.flatMap((result, index) => {
      const sourceKind = sources[index][0];
      if (sourceKind === "tasks") {
        if (result.status === "fulfilled") {
          state.tasks = result.value; state.tasksUpdatedAt = new Date().toISOString(); state.tasksError = null;
        } else state.tasksError = { message: result.reason.message, status: result.reason.status ?? null };
        return [];
      }
      if (result.status === "fulfilled") return result.value;
      const kind = sources[index][0];
      context.warnings.add(`${kind === "inline" ? "Inline" : "Page"}: ${result.reason.message}`);
      return state.comments.filter(item => item.kind === kind);
    }).filter(item => item.mine || item.watched)
      .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    state.lastUpdated = new Date();
    const cache = client.snapshot([...context.warnings]);
    cache.openCount = countOpenItems(state, client);
    if (failed.length) cache.incomplete = true;
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
  const job = enqueue(async () => {
    try {
      const cache = await refreshNow(force);
      await scheduleContinuation(cache.incomplete ? new Error("partialResults") : null);
      return cache;
    } catch (error) { await scheduleContinuation(error); throw error; }
  });
  refreshJob = job;
  job.finally(() => { if (refreshJob === job) refreshJob = null; }).catch(() => {});
  return job;
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "confluence-popup" || port.sender?.id !== chrome.runtime.id || port.sender?.url !== chrome.runtime.getURL("popup.html")) return;
  return ensureAlarm().then(() => { if (!refreshJob) armLoop(); }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")) || message?.type !== "confluence") return false;
  const job = message.action === "refresh" ? refresh(Boolean(message.force))
    : Promise.reject(new Error("readOnly"));
  job.then(value => sendResponse({ ok: true, value }), error => sendResponse({ ok: false, error: { message: error.message, status: error.status } }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME && !refreshJob) resumeLoop().catch(console.error);
});
chrome.runtime.onInstalled.addListener(() => { ensureAlarm().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm().then(() => armLoop()).catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings || changes.commentCache) updateBadge().catch(console.error);
  if (!changes.settings) return;
  ensureAlarm().catch(console.error);
  if (!credentialsEqual(changes.settings.oldValue, changes.settings.newValue)) {
    // The account cache is never reused across credential changes.
    queue.then(async () => { await store.remove("syncControl"); armLoop(); }).catch(console.error);
  }
});
// The timer chains completed passes; the 30-second alarm resumes after worker suspension.
ensureAlarm().then(() => armLoop()).catch(console.error);
updateBadge().catch(console.error);
chrome.permissions.onAdded?.addListener(() => {
  store.remove("syncControl").then(() => armLoop()).catch(console.error);
});
