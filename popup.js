const storage = chrome.storage.local;
const defaults = { settings: { host: "", email: "", token: "", themeMode: "system", languageMode: "system" } };
const state = {
  settings: { ...defaults.settings }, me: null, comments: [], pages: new Map(), activeTab: "mine",
  kind: "all", query: "", loading: false, lastUpdated: null, pageNavigationVersion: 0
};
const $ = (id) => document.getElementById(id);

const i18n = {
  de: {
    connected: "Verbunden", disconnected: "Nicht verbunden", openComments: "Offene Kommentare", mine: "Meine Kommentare",
    mentions: "Erwähnungen", needsReply: "Antwort nötig", allTypes: "Alle Typen", inline: "Inline", pageComment: "Seitenkommentar",
    search: "Kommentare und Seiten suchen …", noResults: "Keine passenden Kommentare gefunden.", configure: "Bitte zuerst deine Confluence-Zugangsdaten hinterlegen.",
    loading: "Lade Kommentare …", refresh: "Aktualisieren", confluenceAccess: "Zugang", connect: "Zugang speichern",
    reportIssue: "Ein Problem melden", createdBy: "Erstellt von Alexander Karge", allRightsReserved: "Alle Rechte vorbehalten",
    preferences: "Darstellung und Sprache", theme: "Theme", language: "Sprache", hostLabel: "Atlassian-Unternehmen",
    system: "System", dark: "Dunkel", light: "Hell", german: "Deutsch", english: "English",
    infoText: "Persönliche Übersicht für Confluence.",
    loginOk: "Verbindung erfolgreich.", loginFailed: "Verbindung fehlgeschlagen.", permissionDenied: "Kein Zugriff auf den angegebenen Host. Bitte Berechtigung erteilen.",
    authFailed: "Anmeldung fehlgeschlagen. Host, Email und API-Token prüfen.", noAccess: "Keine Kommentare gefunden oder keine Berechtigung zum Lesen.",
    ownComment: "Von dir", mentioned: "Du wurdest erwähnt", replyRequired: "Du bist an der Reihe", openPage: "In Confluence öffnen ↗",
    updated: "Aktualisiert", resultCount: "Einträge", tokenLocal: "Das API-Token liegt lokal im Browserprofil. Schütze dein Windows-Benutzerkonto.",
    requestFailed: "Die Confluence-Abfrage ist fehlgeschlagen.", noPage: "Unbekannte Seite", replyCount: "Antworten", rootComment: "Kommentar",
    filterMine: "Meine Kommentare", filterMentions: "Erwähnungen", filterReply: "Antwort erforderlich", footerNote: "Seitenkommentare besitzen keinen Erledigt-Status. Antwortbedarf wird aus dem Gesprächsverlauf abgeleitet."
  },
  en: {
    connected: "Connected", disconnected: "Disconnected", openComments: "Open comments", mine: "My comments", mentions: "Mentions",
    needsReply: "Needs reply", allTypes: "All types", inline: "Inline", pageComment: "Page comment", search: "Search comments and pages …",
    noResults: "No matching comments found.", configure: "Please configure your Confluence credentials first.", loading: "Loading comments …",
    refresh: "Refresh", confluenceAccess: "Access", connect: "Save Access",
    reportIssue: "Report an issue", createdBy: "Created by Alexander Karge", allRightsReserved: "All rights reserved", preferences: "Preferences", theme: "Theme", language: "Language",
    hostLabel: "Atlassian company", system: "System", dark: "Dark", light: "Light", german: "Deutsch", english: "English",
    infoText: "Personal overview for Confluence.", loginOk: "Connection successful.", loginFailed: "Connection failed.",
    permissionDenied: "No access to the configured host. Please grant the permission.", authFailed: "Authentication failed. Check host, email and API token.",
    noAccess: "No comments found or no permission to read comments.", ownComment: "By you", mentioned: "You were mentioned", replyRequired: "Your turn",
    openPage: "Open in Confluence ↗", updated: "Updated", resultCount: "items", tokenLocal: "The API token is stored locally in your browser profile. Protect your Windows account.",
    requestFailed: "The Confluence request failed.", noPage: "Unknown page", replyCount: "replies", rootComment: "Comment",
    filterMine: "My comments", filterMentions: "Mentions", filterReply: "Needs reply", footerNote: "Page comments have no resolved status. Reply need is inferred from the conversation."
  }
};
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
function originOf(host) { return new URL(host).origin; }
function authHeader() { return "Basic " + btoa(`${state.settings.email}:${state.settings.token}`); }
function safeNextUrl(next) {
  const url = new URL(next, state.settings.host);
  if (url.origin !== originOf(state.settings.host)) throw new Error("API lieferte einen Link außerhalb des konfigurierten Hosts.");
  return url.href;
}
async function api(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? safeNextUrl(pathOrUrl) : `${state.settings.host}${pathOrUrl}`;
  const response = await fetch(url, { headers: { Accept: "application/json", Authorization: authHeader() } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`); error.status = response.status;
    try { error.detail = (await response.json()).message; } catch { /* ignore */ }
    throw error;
  }
  return response.json();
}
async function getAll(path) {
  let url = path; const results = []; let pages = 0;
  while (url && pages++ < 500) {
    const data = await api(url);
    results.push(...(data.results ?? []));
    const next = data._links?.next;
    url = next ? safeNextUrl(next) : null;
  }
  if (pages >= 500) throw new Error("Pagination-Limit erreicht. Bitte Datenmenge eingrenzen.");
  return results;
}
function authorId(comment) { return comment.authorId ?? comment.author?.accountId ?? comment.author?.id ?? comment.createdBy?.accountId ?? ""; }
function bodyText(body) {
  if (!body) return "";
  if (typeof body === "string") return body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const adf = body.atlas_doc_format?.value ?? body.atlas_doc_format ?? body;
  if (typeof adf === "string") {
    try { return bodyText(JSON.parse(adf)); } catch { return adf.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
  }
  if (body.storage?.value) return bodyText(body.storage.value);
  const parts = [];
  const walk = node => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;
    if (node.type === "text" && node.text) parts.push(node.text);
    if (node.type === "mention") parts.push(node.attrs?.text ?? "@mention");
    if (node.type === "hardBreak") parts.push(" ");
    if (node.content) walk(node.content);
  };
  walk(adf); return parts.join("").replace(/\s+/g, " ").trim();
}
function mentionsAccount(body, accountId) {
  if (!body || !accountId) return false;
  const raw = body.atlas_doc_format?.value ?? body.atlas_doc_format ?? body;
  let root = raw;
  if (typeof raw === "string") { try { root = JSON.parse(raw); } catch { return raw.includes(accountId); } }
  let found = false;
  const walk = node => {
    if (!node || found) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;
    if (node.type === "mention") {
      const attrs = node.attrs ?? {};
      if ([attrs.id, attrs.accountId, attrs.userId].includes(accountId)) found = true;
    }
    Object.values(node).forEach(value => { if (typeof value === "object") walk(value); });
  };
  walk(root);
  if (!found && body.storage?.value) found = body.storage.value.includes(accountId);
  return found;
}
function pageUrl(pageId, commentId) {
  const base = `${state.settings.host}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
  return commentId ? `${base}&focusedCommentId=${encodeURIComponent(commentId)}` : base;
}
function dateValue(value) { const d = new Date(value ?? 0); return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(lang(), { dateStyle: "medium", timeStyle: "short" }).format(d); }
function isOpen(comment, kind) {
  if (kind === "inline") {
    const status = String(comment.resolutionStatus ?? comment.status ?? "").toLowerCase();
    return comment.resolved !== true && !["resolved", "closed", "done"].includes(status);
  }
  return true;
}
function buildThreads(comments, kind) {
  const byId = new Map(comments.map(c => [String(c.id), { ...c, children: [] }]));
  const roots = [];
  for (const item of byId.values()) {
    const parent = item.parentCommentId ? byId.get(String(item.parentCommentId)) : null;
    if (parent) parent.children.push(item); else roots.push(item);
  }
  return roots.map(root => {
    const all = []; const walk = n => { all.push(n); n.children.forEach(walk); }; walk(root);
    const last = [...all].sort((a,b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0)).at(-1) ?? root;
    const myComments = all.filter(c => authorId(c) === state.me?.accountId).sort((a,b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0));
    const myComment = myComments.at(-1) ?? null;
    const participated = Boolean(myComment) || all.some(c => mentionsAccount(c.body, state.me?.accountId));
    const mentioned = all.some(c => mentionsAccount(c.body, state.me?.accountId));
    const mine = Boolean(myComment);
    const needsReply = participated && authorId(last) !== state.me?.accountId;
    const pageId = root.pageId ?? root.contentId ?? root._links?.webui?.match?.(/pageId=(\d+)/)?.[1] ?? "";
    const page = state.pages.get(String(pageId));
    return { id: String(root.id), kind, root, all, last, myComment, mine, mentioned, needsReply, pageId: String(pageId), pageTitle: page?.title ?? root.pageTitle ?? t("noPage"), url: pageUrl(pageId, myComment?.id ?? root.id), text: bodyText(root.body), updatedAt: last.createdAt ?? root.createdAt, replyCount: Math.max(0, all.length - 1), open: isOpen(root, kind) };
  });
}
async function loadComments() {
  if (!state.settings.host || !state.settings.email || !state.settings.token) { showEmpty(t("configure")); return; }
  state.loading = true; showNotice(t("loading"));
  const loading = document.createElement("div"); loading.className = "empty loading-state";
  loading.innerHTML = '<span class="spinner" aria-hidden="true"></span><span></span>';
  loading.lastElementChild.textContent = t("loading");
  $("commentList").replaceChildren(loading);
  $("refreshButton").disabled = true;
  try {
    const [inline, footer, pages] = await Promise.all([
      getAll("/wiki/api/v2/inline-comments?limit=100&body-format=atlas_doc_format"),
      getAll("/wiki/api/v2/footer-comments?limit=100&body-format=atlas_doc_format"),
      getAll("/wiki/api/v2/pages?limit=250&status=current")
    ]);
    state.pages = new Map(pages.map(p => [String(p.id), p]));
    const inlineRoots = buildThreads(inline, "inline");
    const footerRoots = buildThreads(footer, "footer");
    state.comments = [...inlineRoots, ...footerRoots].filter(x => x.open).sort((a,b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    state.lastUpdated = new Date();
    hideNotice(); render();
  } catch (error) {
    console.error("ConfluenceLog", error);
    showNotice(error.status === 401 ? t("authFailed") : `${t("requestFailed")} (${error.message})`, "error");
    if (error.status === 401) updateConnectionState(false);
  } finally { state.loading = false; $("refreshButton").disabled = false; }
}
function showNotice(message, type = "info") { const el = $("notice"); el.textContent = message; el.className = `notice ${type}`; }
function hideNotice() { $("notice").className = "notice hidden"; }
function showEmpty(message) { $("commentList").replaceChildren(); const el = document.createElement("div"); el.className = "empty"; el.textContent = message; $("commentList").append(el); }
function updateConnectionState(connected = Boolean(state.me)) {
  document.body.classList.toggle("logged-out", !connected);
  $("connectionState").textContent = connected ? `${t("connected")} · ${state.me?.displayName ?? ""}` : t("disconnected");
  if (!connected) activatePage("settings");
}
function make(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function render() {
  const filtered = state.comments.filter(item => {
    const category = state.activeTab === "mine" ? item.mine : state.activeTab === "mentions" ? item.mentioned : item.needsReply;
    const kind = state.kind === "all" || state.kind === item.kind;
    const q = state.query.toLowerCase();
    return category && kind && (!q || `${item.pageTitle} ${item.text} ${bodyText(item.last.body)}`.toLowerCase().includes(q));
  });
  $("openCount").textContent = state.comments.length;
  $("resultCount").textContent = `${filtered.length} ${t("resultCount")}`;
  $("lastUpdated").textContent = state.lastUpdated ? `${t("updated")}: ${dateValue(state.lastUpdated)}` : "";
  const list = $("commentList"); list.replaceChildren();
  if (!state.comments.length) { showEmpty(state.me ? t("noAccess") : t("configure")); return; }
  if (!filtered.length) { showEmpty(t("noResults")); return; }
  for (const item of filtered) {
    const card = make("article", "comment-card");
    const header = make("div", "comment-header");
    const title = make("div", "comment-title"); title.append(make("strong", "", item.pageTitle));
    const type = make("span", `type-badge ${item.kind}`, item.kind === "inline" ? t("inline") : t("pageComment"));
    header.append(title, type); card.append(header);
    const meta = make("div", "comment-meta");
    const author = item.root.author?.displayName ?? item.root.author?.publicName ?? item.root.authorId ?? "";
    meta.textContent = `${author}${author ? " · " : ""}${dateValue(item.root.createdAt)}${item.replyCount ? ` · ${item.replyCount} ${t("replyCount")}` : ""}`;
    card.append(meta);
    const primaryComment = state.activeTab === "mine" && item.myComment ? bodyText(item.myComment.body) : item.text;
    card.append(make("p", "comment-text", primaryComment || "(ohne Text)"));
    if (item.replyCount) card.append(make("p", "latest-reply", `${item.last.author?.displayName ?? item.last.authorId ?? ""}: ${bodyText(item.last.body)}`));
    const flags = make("div", "flags");
    if (item.mine) flags.append(make("span", "flag mine", t("ownComment")));
    if (item.mentioned) flags.append(make("span", "flag mention", t("mentioned")));
    if (item.needsReply) flags.append(make("span", "flag reply", t("replyRequired")));
    if (flags.childElementCount) card.append(flags);
    const footer = make("div", "comment-footer"); const link = make("a", "open-link", t("openPage")); link.href = item.url; link.target = "_blank"; link.rel = "noreferrer"; footer.append(link); card.append(footer);
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
      await storage.set({ settings: state.settings });
      updateConnectionState(true); applyLanguage(); showNotice(t("loginOk"), "success");
      await loadComments();
      if (state.pageNavigationVersion === pageNavigationVersion) activatePage("comments");
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
  document.querySelectorAll(".tab").forEach(el => el.classList.toggle("active", el.dataset.page === name));
  document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === `page${name[0].toUpperCase()}${name.slice(1)}`));
}
function applyTheme() {
  const mode = state.settings.themeMode;
  document.documentElement.dataset.theme = mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
}
async function init() {
  const stored = await storage.get("settings"); state.settings = { ...defaults.settings, ...(stored.settings ?? {}) };
  $("host").value = hostTenant(state.settings.host); $("email").value = state.settings.email; $("token").value = state.settings.token;
  $("themeMode").value = state.settings.themeMode; $("languageMode").value = state.settings.languageMode;
  applyTheme(); applyLanguage();
  document.querySelectorAll(".tab").forEach(el => el.addEventListener("click", () => {
    state.pageNavigationVersion++;
    activatePage(el.dataset.page);
  }));
  document.querySelectorAll(".filter-tab").forEach(el => el.addEventListener("click", () => {
    state.activeTab = el.dataset.filter; document.querySelectorAll(".filter-tab").forEach(x => x.classList.toggle("active", x === el)); render();
  }));
  $("kindFilter").addEventListener("change", e => { state.kind = e.target.value; render(); });
  $("searchInput").addEventListener("input", e => { state.query = e.target.value; render(); });
  $("refreshButton").addEventListener("click", loadComments);
  $("settingsForm").addEventListener("submit", saveSettings);
  $("themeMode").addEventListener("change", async e => { state.settings.themeMode = e.target.value; applyTheme(); await storage.set({ settings: state.settings }); });
  $("languageMode").addEventListener("change", async e => { state.settings.languageMode = e.target.value; await storage.set({ settings: state.settings }); applyLanguage(); });
  updateConnectionState(false);
  if (state.settings.host && state.settings.email && state.settings.token) {
    const pageNavigationVersion = state.pageNavigationVersion;
    try {
      const origin = originOf(state.settings.host);
      const permitted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (!permitted) { showNotice(t("permissionDenied"), "error"); return; }
      state.me = await api("/wiki/rest/api/user/current");
      if (!state.me?.accountId) throw new Error("Confluence hat keinen gültigen Benutzer zurückgegeben.");
      updateConnectionState(true);
      await loadComments();
      if (state.pageNavigationVersion === pageNavigationVersion) activatePage("comments");
    } catch (error) {
      state.me = null; updateConnectionState(false);
      showNotice(error.status === 401 ? t("authFailed") : `${t("loginFailed")} ${error.message}`, "error");
    }
  }
}
init().catch(error => { console.error(error); showNotice(error.message, "error"); });
