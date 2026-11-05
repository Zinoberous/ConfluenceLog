const storage = chrome.storage.local;
const defaults = { settings: { host: "", email: "", token: "", themeMode: "system", languageMode: "system" } };
const state = {
  settings: { ...defaults.settings }, me: null, comments: [], pages: new Map(), activeTab: "mine", kind: "all", expanded: new Set(), users: new Map(),
  query: "", activePage: "comments", scrollTop: 0, restoringScroll: false, scrollRestoreVersion: 0, loading: false, hasCache: false, cacheRevision: 0, pendingCache: null, lastUpdated: null, pageNavigationVersion: 0
};
const $ = (id) => document.getElementById(id);

const i18n = {
  de: {
    connected: "Verbunden", disconnected: "Nicht verbunden", openComments: "Offene Kommentare", mine: "Meine Kommentare",
    watched: "Beteiligt", replied: "Du hast geantwortet", inline: "Inline", pageComment: "Seite", allTypes: "Alle Typen",
    search: "Kommentare und Seiten suchen …", noResults: "Keine passenden Kommentare gefunden.", configure: "Bitte zuerst deine Confluence-Zugangsdaten hinterlegen.",
    loading: "Lade Kommentare …", refresh: "Aktualisieren", confluenceAccess: "Zugang", connect: "Zugang speichern",
    reportIssue: "Ein Problem melden", createdBy: "Erstellt von Alexander Karge", allRightsReserved: "Alle Rechte vorbehalten",
    preferences: "Darstellung und Sprache", theme: "Theme", language: "Sprache", hostLabel: "Atlassian-Unternehmen",
    system: "System", dark: "Dunkel", light: "Hell", german: "Deutsch", english: "English",
    infoText: "Persönliche Übersicht für Confluence.",
    loginOk: "Verbindung erfolgreich.", loginFailed: "Verbindung fehlgeschlagen.", permissionDenied: "Kein Zugriff auf den angegebenen Host. Bitte Berechtigung erteilen.",
    authFailed: "Anmeldung fehlgeschlagen. Host, Email und API-Token prüfen.", noAccess: "Keine Kommentare gefunden oder keine Berechtigung zum Lesen.",
    ownComment: "Von dir", mentioned: "Du wurdest erwähnt", openPage: "In Confluence öffnen ↗",
    updated: "Aktualisiert", resultCount: "Einträge", tokenLocal: "Das API-Token liegt lokal im Browserprofil. Schütze dein Windows-Benutzerkonto.",
    requestFailed: "Die Confluence-Abfrage ist fehlgeschlagen.", noPage: "Unbekannte Seite", rootComment: "Kommentar",
  },
  en: {
    connected: "Connected", disconnected: "Disconnected", openComments: "Open comments", mine: "My comments", watched: "Involved", replied: "You replied",
    inline: "Inline", pageComment: "Page", allTypes: "All types", search: "Search comments and pages …",
    noResults: "No matching comments found.", configure: "Please configure your Confluence credentials first.", loading: "Loading comments …",
    refresh: "Refresh", confluenceAccess: "Access", connect: "Save Access",
    reportIssue: "Report an issue", createdBy: "Created by Alexander Karge", allRightsReserved: "All rights reserved", preferences: "Preferences", theme: "Theme", language: "Language",
    hostLabel: "Atlassian company", system: "System", dark: "Dark", light: "Light", german: "Deutsch", english: "English",
    infoText: "Personal overview for Confluence.", loginOk: "Connection successful.", loginFailed: "Connection failed.",
    permissionDenied: "No access to the configured host. Please grant the permission.", authFailed: "Authentication failed. Check host, email and API token.",
    noAccess: "No comments found or no permission to read comments.", ownComment: "By you", mentioned: "You were mentioned",
    openPage: "Open in Confluence ↗", updated: "Updated", resultCount: "items", tokenLocal: "The API token is stored locally in your browser profile. Protect your Windows account.",
    requestFailed: "The Confluence request failed.", noPage: "Unknown page", rootComment: "Comment",
  }
};
const dataClient = createConfluenceClient(state, t, lang);
const { originOf, authHeader, safeNextUrl, api, getAll, authorId, createdAt, bodyText, mentionsAccount, pageUrl, dateValue, isOpen, filterOpenComments, buildThreads, createCommentLoadContext, loadPageComments, parallelMap, itemKey, displayAuthor, commentSources } = dataClient;
function lang() { return state.settings.languageMode === "de" || state.settings.languageMode === "en" ? state.settings.languageMode : (navigator.language?.toLowerCase().startsWith("de") ? "de" : "en"); }
function t(key) { return i18n[lang()][key] ?? key; }
function applyLanguage() {
  document.documentElement.lang = lang();
  document.querySelectorAll("[data-i18n]").forEach(el => el.textContent = t(el.dataset.i18n));
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => el.placeholder = t(el.dataset.i18nPlaceholder));
  updateConnectionState(); render();
}
function normalizeHost(value) {
  const tenant = value.trim();
  if (tenant.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(tenant)) {
    throw new Error("Bitte nur den Atlassian-Unternehmensnamen angeben (z. B. your-company).");
  }
  return `https://${tenant.toLowerCase()}.atlassian.net`;
}
function hostTenant(host) {
  try {
    const url = new URL(host);
    const match = url.hostname.match(/^([a-z0-9-]+)\.atlassian\.net$/i);
    return match ? match[1] : host;
  } catch {
    return host;
  }
}
async function workerRequest(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type: "confluence", action, ...extra });
  if (!response?.ok) throw Object.assign(new Error(response?.error?.message ?? t("requestFailed")), { status: response?.error?.status });
  return response.value;
}
function applyCommentCache(cache) {
  if (!matchesConfluenceCache(cache, state.settings) || (cache.revision ?? 0) < state.cacheRevision) return false;
  if (!dataClient.restore(cache)) return false;
  state.hasCache = true; state.cacheRevision = cache.revision ?? 0;
  setLoadHints((cache.warnings ?? []).map(warning => t(warning)));
  updateConnectionState(true); render();
  return true;
}
function flushPendingCache() {
  if (!state.loading && state.pendingCache) {
    const cache = state.pendingCache; state.pendingCache = null; applyCommentCache(cache);
  }
}
function persistView() {
  if (!state.me || !chrome.storage.session) return;
  chrome.storage.session.set({ commentView: {
    host: state.settings.host, email: state.settings.email, accountId: state.me.accountId,
    activeTab: state.activeTab, kind: state.kind, query: state.query, scrollTop: state.scrollTop, expanded: [...state.expanded]
  } }).catch(console.error);
}
function rememberScroll() {
  if (typeof window === "undefined" || state.activePage !== "comments" || state.restoringScroll) return;
  state.scrollTop = Math.max(0, window.scrollY);
}
function restoreScroll() {
  if (typeof window === "undefined" || state.activePage !== "comments") return;
  state.restoringScroll = true;
  const version = ++state.scrollRestoreVersion;
  window.requestAnimationFrame(() => {
    if (version !== state.scrollRestoreVersion) return;
    if (state.activePage === "comments") window.scrollTo(0, state.scrollTop);
    state.restoringScroll = false;
  });
}
async function loadComments(force = true) {
  if (state.loading) return;
  if (!state.settings.host || !state.settings.email || !state.settings.token) { showEmpty(t("configure")); return; }
  state.loading = true; hideNotice();
  if (!state.hasCache) setLoadHints([]);
  render(); $("refreshButton").disabled = true;
  try {
    const cache = await workerRequest("refresh", { force });
    applyCommentCache(cache); hideNotice();
  } catch (error) {
    showNotice(error.status === 401 ? t("authFailed") : `${t("requestFailed")} (${t(error.message)})`, "error", "comments");
    if (!state.me) showNotice(`${t("requestFailed")} (${t(error.message)})`, "error");
    if (error.status === 401) { state.me = null; state.hasCache = false; state.comments = []; updateConnectionState(false); showNotice(t("authFailed"), "error"); }
  } finally {
    state.loading = false; $("refreshButton").disabled = false; render(); flushPendingCache();
  }
}
function applySyncStatus(status) {
  if (!status || status.host !== state.settings.host || status.email !== state.settings.email) return;
  if (status.me?.accountId && !state.me) {
    state.me = status.me; updateConnectionState(true);
    if (state.pageNavigationVersion === 0) activatePage("comments");
    render();
  }
  $("refreshButton").classList.toggle("syncing", status.state === "syncing");
  $("refreshButton").title = t(status.state === "syncing" ? "backgroundRefresh" : "refresh");
  if (status.state === "error") {
    if (status.status === 401) { state.me = null; state.hasCache = false; state.comments = []; updateConnectionState(false); showNotice(t("authFailed"), "error"); }
    else if (state.hasCache) showNotice(`${t("cachedRefreshFailed")} (${t(status.message)})`, "error", "comments");
  } else if (status.state === "idle") hideNotice();
}
function setLoadHints(warnings) {
  const details = $("loadHints");
  details.classList.toggle("hidden", !warnings.length);
  if (!warnings.length) details.open = false;
  $("loadHintsText").textContent = warnings.join(" · ");
}
function showNotice(message, type = "info", page = "settings") { const el = $(page === "comments" ? "notice" : "settingsNotice"); el.textContent = message; el.className = `notice ${type}`; }
function hideNotice() { $("notice").className = "notice hidden"; }
function showEmpty(message) { $("commentList").replaceChildren(); const el = document.createElement("div"); el.className = "empty"; el.textContent = message; $("commentList").append(el); }
function updateConnectionState(connected = Boolean(state.me)) {
  document.body.classList.toggle("logged-out", !connected);
  $("connectionState").textContent = connected ? `${t("connected")} · ${state.me?.displayName ?? ""}` : t("disconnected");
  if (!connected) activatePage("settings");
}
function make(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function render() {
  rememberScroll(); restoreScroll();
  const list = $("commentList");
  list.setAttribute("aria-busy", String(state.loading));
  if (state.query.trim().toLowerCase() === "easter egg") {
    const egg = make("div", "search-easter-egg");
    const animation = make("img"); animation.src = "https://i.gifer.com/ZC9P.gif";
    animation.alt = "Easter egg"; animation.loading = "lazy"; animation.referrerPolicy = "no-referrer";
    egg.append(animation); list.replaceChildren(egg);
    $("resultCount").textContent = "";
    return;
  }
  if (state.loading && !state.hasCache) {
    const loading = make("div", "empty loading-state");
    const spinner = make("span", "spinner"); spinner.setAttribute("aria-hidden", "true");
    loading.append(spinner, make("span", "", t("loading")));
    list.replaceChildren(loading);
    $("resultCount").textContent = "";
    return;
  }
  const filtered = state.comments.filter(item => {
    const category = state.activeTab === "done" ? true : state.activeTab === "mine" ? item.mine : state.activeTab === "watched" && item.watched;
    const open = item.open;
    if (state.activeTab === "done" ? open : !open) return false;
    const q = state.query.toLowerCase();
    return category && (state.kind === "all" || item.kind === state.kind) && (!q || `${item.pageTitle} ${item.all.map(c => bodyText(c.body)).join(" ")}`.toLowerCase().includes(q));
  });
  if (state.activeTab === "done") filtered.sort((a, b) =>
    (Date.parse(b.resolvedAt) || 0) - (Date.parse(a.resolvedAt) || 0) ||
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  $("openCount").textContent = state.comments.filter(item => item.open).length;
  $("resultCount").textContent = `${filtered.length} ${t("resultCount")}`;
  $("lastUpdated").textContent = state.lastUpdated ? `${t("updated")}: ${dateValue(state.lastUpdated)}` : "";
  list.replaceChildren();
  if (!state.comments.length) { showEmpty(state.me ? t("noAccess") : t("configure")); return; }
  if (!filtered.length) { showEmpty(t("noResults")); return; }
  for (const item of filtered) {
    const card = make("article", "comment-card");
    const header = make("div", "comment-header");
    const title = make("div", "comment-title"); title.append(make("strong", "", item.pageTitle));
    const type = make("span", `type-badge ${item.kind}`, t(item.kind === "inline" ? "inline" : "pageComment"));
    header.append(title, type); card.append(header);
    const meta = make("div", "comment-meta");
    const author = displayAuthor(item.root);
    meta.textContent = `${author}${author ? " · " : ""}${dateValue(createdAt(item.root))}`;
    const differentResolver = item.resolvedById && item.resolvedById !== authorId(item.root);
    if (!item.open && (item.resolvedAt || differentResolver)) {
      const resolvedDate = item.resolvedAt ? `: ${dateValue(item.resolvedAt)}` : "";
      meta.textContent += ` · ${t("resolvedOn")}${resolvedDate}`;
      if (differentResolver) meta.append(make("strong", "", ` ${t("by")} ${displayAuthor({ authorId: item.resolvedById })}`));
    }
    card.append(meta);
    const primaryComment = item.text;
    card.append(make("p", "comment-text", primaryComment || "(ohne Text)"));
    const flags = make("div", "flags");
    if (item.mine) flags.append(make("span", "flag mine", t("ownComment")));
    if (item.mentioned) flags.append(make("span", "flag mention", t("mentioned")));
    if (item.replied) flags.append(make("span", "flag watched", t("replied")));
    if (flags.childElementCount) card.append(flags);
    appendConversation(card, item);
    list.append(card);
  }
}
async function saveSettings(event) {
  event.preventDefault();
  const pageNavigationVersion = state.pageNavigationVersion;
  try {
    const host = normalizeHost($("host").value);
    const origin = originOf(host);
    const candidateSettings = { ...state.settings, host, email: $("email").value.trim(), token: $("token").value, themeMode: $("themeMode").value, languageMode: $("languageMode").value };
    if (!candidateSettings.email || !candidateSettings.token) throw new Error("Email und API-Token sind erforderlich.");

    // Request the optional host permission immediately from the submit gesture.
    // Awaiting permissions.contains() first can lose Chromium's user activation.
    const permissionGranted = chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!(await permissionGranted)) throw new Error(t("permissionDenied"));

    const previousSettings = state.settings;
    state.settings = candidateSettings;
    try {
      const me = await api("/wiki/rest/api/user/current");
      if (!me?.accountId) throw new Error("Confluence hat keinen gültigen Benutzer zurückgegeben.");
      state.me = me;
      state.comments = []; state.pages.clear(); state.users.clear(); state.originals.clear(); state.expanded.clear();
      state.hasCache = false; state.cacheRevision = 0; state.pendingCache = null; state.scrollTop = 0;
      await storage.remove(["commentCache", "syncStatus"]);
      if (chrome.storage.session) await chrome.storage.session.remove("commentView");
      await storage.set({ settings: state.settings });
      updateConnectionState(true); applyLanguage(); showNotice(t("loginOk"), "success");
      if (state.pageNavigationVersion === pageNavigationVersion) activatePage("comments");
      await loadComments();
    } catch (error) {
      state.settings = previousSettings;
      state.me = null;
      updateConnectionState(false);
      if (error.status === 401) throw new Error(`${t("authFailed")} (HTTP 401)`);
      if (error.status === 403) throw new Error(`Zugriff verweigert (HTTP 403). Prüfe, ob dein Konto Confluence verwenden darf.`);
      throw error;
    }
  } catch (error) { showNotice(`${t("loginFailed")} ${error.message}`, "error"); }
}
function activatePage(name) {
  rememberScroll();
  state.activePage = name;
  document.querySelectorAll(".tab").forEach(el => el.classList.toggle("active", el.dataset.page === name));
  document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === `page${name[0].toUpperCase()}${name.slice(1)}`));
  if (name === "comments") restoreScroll();
}
function applyTheme() {
  const mode = state.settings.themeMode;
  document.documentElement.dataset.theme = mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
}
function activateAltThemeVariant() {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = `${theme}-alt`;
}
function setupEasterEggs() {
  let logoClicks = 0;
  let logoTriggered = false;
  const triggerLogo = () => {
    if (logoTriggered || ++logoClicks < 10) return;
    logoTriggered = true;
    $("brandLogo").classList.toggle("hidden", true);
    $("brandEmoji").classList.toggle("hidden", false);
  };
  $("brandLogo").addEventListener("click", triggerLogo);
  $("brandEmoji").addEventListener("click", triggerLogo);
  let infoClicks = 0;
  let infoTimeout;
  $("tabInfo").addEventListener("click", () => {
    clearTimeout(infoTimeout);
    if (++infoClicks === 5) { activateAltThemeVariant(); infoClicks = 0; }
    infoTimeout = setTimeout(() => { infoClicks = 0; }, 2000);
  });
}
function createCommentSection(item, section, label) {
  const key = `${itemKey(item)}|${section}`;
  const wrapper = make("div", "comment-section");
  const header = make("div", "comment-footer conversation-header");
  const panel = make("div", "comment-expanded");
  panel.id = `comment-${item.kind}-${item.id}-${section}`;
  panel.hidden = !state.expanded.has(key);
  const toggle = make("button", "expand-button"); toggle.type = "button";
  toggle.setAttribute("aria-controls", panel.id);
  function updateToggle() {
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    toggle.textContent = `${panel.hidden ? "▸" : "▾"} ${label}`;
  }
  updateToggle();
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) state.expanded.delete(key); else state.expanded.add(key);
    updateToggle(); persistView();
  });
  header.append(toggle); wrapper.append(header, panel);
  return { wrapper, header, panel };
}
function appendConversation(card, item) {
  const replies = item.all.filter(comment => String(comment.id) !== item.id);
  const link = make("a", "open-link", t("openPage")); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
  const linkRow = make("div", "comment-footer comment-link-row");
  link.addEventListener("click", () => { rememberScroll(); persistView(); });
  linkRow.append(link);
  card.append(linkRow);
  if (!replies.length) return;
  const conversation = createCommentSection(item, "conversation", `${t("replies")} (${replies.length})`);
  const details = make("div", "conversation");
  for (const comment of [...replies].sort((a,b) => new Date(createdAt(a)) - new Date(createdAt(b)))) {
    const entry = make("div", "conversation-entry");
    entry.append(make("div", "comment-meta", `${displayAuthor(comment)} · ${dateValue(createdAt(comment))}`), make("p", "", bodyText(comment.body)));
    details.append(entry);
  }
  conversation.panel.append(details);
  card.append(conversation.wrapper);
}
Object.assign(i18n.de, {
  backgroundRefresh: "Wird im Hintergrund aktualisiert …", cachedRefreshFailed: "Aktualisierung fehlgeschlagen. Letzter gespeicherter Stand wird angezeigt.",
  loadHints: "Hinweise zur Übersicht",
  partialResults: "Die Übersicht ist unvollständig.", missingComments: "Einzelne Seiten oder Kommentare sind nicht mehr zugänglich.", missingAuthors: "Einzelne ursprüngliche Autoren konnten nicht ermittelt werden.",
  by: "von", resolvedOn: "Erledigt", done: "Erledigt", replies: "Antworten",
  noAccess: "Keine relevanten Kommentare vorhanden."
});
Object.assign(i18n.en, {
  backgroundRefresh: "Refreshing in the background …", cachedRefreshFailed: "Refresh failed. Showing the last saved data.",
  loadHints: "Overview notes",
  partialResults: "The overview is incomplete.", missingComments: "Some pages or comments are no longer accessible.", missingAuthors: "Some original authors could not be retrieved.",
  by: "by", resolvedOn: "Resolved", done: "Done", replies: "Replies",
  noAccess: "No relevant comments found."
});
async function init() {
  const stored = await storage.get(["settings", "commentCache", "syncStatus"]); state.settings = { ...defaults.settings, ...(stored.settings ?? {}) };
  $("host").value = hostTenant(state.settings.host); $("email").value = state.settings.email; $("token").value = state.settings.token;
  $("themeMode").value = state.settings.themeMode; $("languageMode").value = state.settings.languageMode;
  applyTheme(); applyLanguage(); setupEasterEggs();
  document.querySelectorAll(".tab").forEach(el => el.addEventListener("click", () => {
    state.pageNavigationVersion++;
    activatePage(el.dataset.page);
  }));
  document.querySelectorAll(".filter-tab").forEach(el => el.addEventListener("click", () => {
    state.activeTab = el.dataset.filter; document.querySelectorAll(".filter-tab").forEach(x => x.classList.toggle("active", x === el)); persistView(); render();
  }));
  $("kindFilter").addEventListener("change", e => { state.kind = e.target.value; persistView(); render(); });
  $("searchInput").addEventListener("input", e => { state.query = e.target.value; persistView(); render(); });
  $("refreshButton").addEventListener("click", () => loadComments(true));
  $("settingsForm").addEventListener("submit", saveSettings);
  $("themeMode").addEventListener("change", async e => { state.settings.themeMode = e.target.value; applyTheme(); await storage.set({ settings: state.settings }); });
  $("languageMode").addEventListener("change", async e => { state.settings.languageMode = e.target.value; await storage.set({ settings: state.settings }); applyLanguage(); });
  let scrollSaveTimer;
  window.addEventListener("scroll", () => {
    rememberScroll();
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(persistView, 120);
  }, { passive: true });
  window.addEventListener("pagehide", () => { rememberScroll(); persistView(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.commentCache?.newValue) {
      const cache = changes.commentCache.newValue;
      if (state.loading) state.pendingCache = cache;
      else applyCommentCache(cache);
    }
    if (changes.syncStatus) applySyncStatus(changes.syncStatus.newValue);
  });
  updateConnectionState(false);
  if (state.settings.host && state.settings.email && state.settings.token) {
    const permitted = await chrome.permissions.contains({ origins: [`${originOf(state.settings.host)}/*`] });
    if (!permitted) { showNotice(t("permissionDenied"), "error"); return; }
    const restored = applyCommentCache(stored.commentCache);
    if (restored && chrome.storage.session) {
      const { commentView: view } = await chrome.storage.session.get("commentView");
      if (view?.host === state.settings.host && view.email === state.settings.email && view.accountId === state.me.accountId) {
        state.activeTab = ["mine", "watched", "done"].includes(view.activeTab) ? view.activeTab : "mine";
        state.query = view.query ?? ""; state.kind = ["all", "inline", "footer"].includes(view.kind) ? view.kind : "all"; state.expanded = new Set((view.expanded ?? []).filter(key => key.endsWith("|conversation")));
        state.scrollTop = view.activeTab !== "all" && Number.isFinite(view.scrollTop) ? Math.max(0, view.scrollTop) : 0;
        $("kindFilter").value = state.kind;
        $("searchInput").value = state.query;
        document.querySelectorAll(".filter-tab").forEach(el => el.classList.toggle("active", el.dataset.filter === state.activeTab));
        render();
      }
    }
    if (restored) { activatePage("comments"); applySyncStatus(stored.syncStatus); }
    await loadComments(false);
    if (state.me && state.pageNavigationVersion === 0) activatePage("comments");
  }
}
init().catch(error => { console.error(error); showNotice(error.message, "error"); });
