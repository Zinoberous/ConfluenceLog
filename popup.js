const storage = chrome.storage.local;
const defaults = { settings: { host: "", email: "", token: "", themeMode: "system", languageMode: "system" } };
const state = {
  settings: { ...defaults.settings }, me: null, comments: [], pages: new Map(), activeTab: "all", dismissed: {}, drafts: new Map(), expanded: new Set(), busy: new Set(), users: new Map(),
  kind: "all", query: "", loading: false, lastUpdated: null, pageNavigationVersion: 0
};
const $ = (id) => document.getElementById(id);

const i18n = {
  de: {
    connected: "Verbunden", disconnected: "Nicht verbunden", openComments: "Offene Kommentare", mine: "Meine Kommentare",
    watched: "Beobachtet", replied: "Du hast geantwortet", allTypes: "Alle Typen", inline: "Inline", pageComment: "Seite",
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
    requestFailed: "Die Confluence-Abfrage ist fehlgeschlagen.", noPage: "Unbekannte Seite", replyCount: "Antworten", rootComment: "Kommentar",
    footerNote: "Seitenkommentare besitzen keinen Erledigt-Status."
  },
  en: {
    connected: "Connected", disconnected: "Disconnected", openComments: "Open comments", mine: "My comments", watched: "Watching", replied: "You replied",
    allTypes: "All types", inline: "Inline", pageComment: "Page", search: "Search comments and pages …",
    noResults: "No matching comments found.", configure: "Please configure your Confluence credentials first.", loading: "Loading comments …",
    refresh: "Refresh", confluenceAccess: "Access", connect: "Save Access",
    reportIssue: "Report an issue", createdBy: "Created by Alexander Karge", allRightsReserved: "All rights reserved", preferences: "Preferences", theme: "Theme", language: "Language",
    hostLabel: "Atlassian company", system: "System", dark: "Dark", light: "Light", german: "Deutsch", english: "English",
    infoText: "Personal overview for Confluence.", loginOk: "Connection successful.", loginFailed: "Connection failed.",
    permissionDenied: "No access to the configured host. Please grant the permission.", authFailed: "Authentication failed. Check host, email and API token.",
    noAccess: "No comments found or no permission to read comments.", ownComment: "By you", mentioned: "You were mentioned",
    openPage: "Open in Confluence ↗", updated: "Updated", resultCount: "items", tokenLocal: "The API token is stored locally in your browser profile. Protect your Windows account.",
    requestFailed: "The Confluence request failed.", noPage: "Unknown page", replyCount: "replies", rootComment: "Comment",
    footerNote: "Page comments have no resolved status."
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
  const url = new URL(next, `${state.settings.host}/wiki/`);
  if (/^\/(?:api\/v2|rest\/api)(?:\/|$)/.test(url.pathname)) url.pathname = `/wiki${url.pathname}`;
  if (url.origin !== originOf(state.settings.host)) throw new Error("API lieferte einen Link außerhalb des konfigurierten Hosts.");
  return url.href;
}
async function api(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? safeNextUrl(pathOrUrl) : `${state.settings.host}${pathOrUrl}`;
  const response = await fetch(url, { ...options, redirect: "error", headers: { Accept: "application/json", Authorization: authHeader(), ...(options.body ? { "Content-Type": "application/json" } : {}) } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} · ${options.method ?? "GET"} ${new URL(url).pathname}`); error.status = response.status; error.path = new URL(url).pathname;
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
  if (url) throw new Error("Pagination-Limit erreicht. Bitte Datenmenge eingrenzen.");
  return results;
}
function authorId(comment) { return comment.authorId ?? comment.author?.accountId ?? comment.author?.id ?? comment.createdBy?.accountId ?? comment.version?.authorId ?? ""; }
function createdAt(comment) { return comment.createdAt ?? comment.version?.createdAt; }
function bodyText(body) {
  if (!body) return "";
  if (typeof body === "string") return new DOMParser().parseFromString(body, "text/html").body.textContent.replace(/\s+/g, " ").trim();
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
    if (["paragraph", "heading", "listItem"].includes(node.type)) parts.push(" ");
  };
  walk(adf); return parts.join("").replace(/\s+/g, " ").trim();
}
function mentionsAccount(body, accountId) {
  if (!body || !accountId) return false;
  const raw = body.atlas_doc_format?.value ?? body.atlas_doc_format ?? body;
  let root = raw;
  if (typeof raw === "string") { try { root = JSON.parse(raw); } catch { return [...new DOMParser().parseFromString(raw, "text/html").querySelectorAll("*")].some(el => (el.getAttribute("ri:account-id") ?? el.getAttribute("data-account-id")) === accountId); } }
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
  if (!found && body.storage?.value) found = mentionsAccount(body.storage.value, accountId);
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
  const byId = new Map(comments.filter(c => !c.status || c.status === "current").map(c => [String(c.id), { ...c, children: [] }]));
  const roots = [];
  for (const item of byId.values()) {
    const parent = item.parentCommentId ? byId.get(String(item.parentCommentId)) : null;
    if (parent) parent.children.push(item); else roots.push(item);
  }
  return roots.map(root => {
    const all = []; const walk = n => { all.push(n); n.children.forEach(walk); }; walk(root);
    const last = [...all].sort((a,b) => new Date(createdAt(a) ?? 0) - new Date(createdAt(b) ?? 0)).at(-1) ?? root;
    const myComments = all.filter(c => authorId(c) === state.me?.accountId).sort((a,b) => new Date(createdAt(a) ?? 0) - new Date(createdAt(b) ?? 0));
    const myComment = myComments.at(-1) ?? null;
    const mentioned = all.some(c => mentionsAccount(c.body, state.me?.accountId));
    const mine = Boolean(state.me?.accountId) && authorId(root) === state.me.accountId;
    const replied = all.some(c => c !== root && authorId(c) === state.me?.accountId);
    const watched = replied || mentioned;
    const pageId = root.pageId ?? root.blogPostId ?? root.contentId ?? root._links?.webui?.match?.(/pageId=(\d+)/)?.[1] ?? "";
    const page = state.pages.get(String(pageId));
    return { id: String(root.id), kind, root, all, last, myComment, mine, mentioned, replied, watched, pageId: String(pageId), pageTitle: page?.title ?? root.pageTitle ?? t("noPage"), url: pageUrl(pageId, myComment?.id ?? root.id), text: bodyText(root.body), updatedAt: createdAt(last) ?? createdAt(root), replyCount: Math.max(0, all.length - 1), open: isOpen(root, kind) };
  });
}
async function loadComments() {
  if (state.loading || state.busy.size) return;
  if (!state.settings.host || !state.settings.email || !state.settings.token) { showEmpty(t("configure")); return; }
  state.loading = true; hideNotice(); setLoadHints([]);
  render();
  $("refreshButton").disabled = true;
  try {
    const context = createCommentLoadContext();
    const entries = Object.entries(commentSources);
    const collections = await Promise.allSettled(entries.map(([, source]) => source.load(context)));
    const unauthorized = collections.find(result => result.status === "rejected" && result.reason.status === 401);
    if (unauthorized) throw unauthorized.reason;
    const failed = collections.flatMap((result, index) => result.status === "rejected" ? [{ kind: entries[index][0], error: result.reason }] : []);
    if (failed.length === entries.length) throw failed[0].error;
    // A failure in one comment type must not hide the other type's results.
    state.comments = collections.flatMap((result, index) => result.status === "fulfilled" ? result.value : state.comments.filter(item => item.kind === entries[index][0]))
      .filter(x => x.mine || x.watched)
      .sort((a,b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    state.lastUpdated = new Date();
    hideNotice();
    setLoadHints([...context.warnings]);
    if (failed.length) {
      const errors = failed.map(({ kind, error }) => `${t(kind === "inline" ? "inline" : "pageComment")}: ${error.message}`);
      showNotice(`${t("partialResults")} ${errors.join(" · ")}`, "error", "comments");
    }
  } catch (error) {
    console.error("ConfluenceLog", error);
    showNotice(error.status === 401 ? t("authFailed") : `${t("requestFailed")} (${error.message})`, "error", "comments");
    if (error.status === 401) { updateConnectionState(false); showNotice(t("authFailed"), "error"); }
  } finally { state.loading = false; $("refreshButton").disabled = false; render(); }
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
  const list = $("commentList");
  list.setAttribute("aria-busy", String(state.loading));
  if (state.loading) {
    const loading = make("div", "empty loading-state");
    const spinner = make("span", "spinner"); spinner.setAttribute("aria-hidden", "true");
    loading.append(spinner, make("span", "", t("loading")));
    list.replaceChildren(loading);
    $("resultCount").textContent = "";
    return;
  }
  const filtered = state.comments.filter(item => {
    const category = state.activeTab === "all" || state.activeTab === "done" ? true : state.activeTab === "mine" ? item.mine : state.activeTab === "watched" && item.watched;
    const open = item.open && state.dismissed[itemKey(item)] !== fingerprint(item);
    if (state.activeTab === "done" ? open : !open) return false;
    const kind = state.kind === "all" || state.kind === item.kind;
    const q = state.query.toLowerCase();
    return category && kind && (!q || `${item.pageTitle} ${item.all.map(c => bodyText(c.body)).join(" ")}`.toLowerCase().includes(q));
  });
  $("openCount").textContent = state.comments.filter(item => item.open && state.dismissed[itemKey(item)] !== fingerprint(item)).length;
  $("resultCount").textContent = `${filtered.length} ${t("resultCount")}`;
  $("lastUpdated").textContent = state.lastUpdated ? `${t("updated")}: ${dateValue(state.lastUpdated)}` : "";
  list.replaceChildren();
  if (!state.comments.length) { showEmpty(state.me ? t("noAccess") : t("configure")); return; }
  if (!filtered.length) { showEmpty(t("noResults")); return; }
  for (const item of filtered) {
    const card = make("article", "comment-card");
    const header = make("div", "comment-header");
    const title = make("div", "comment-title"); title.append(make("strong", "", item.pageTitle));
    const type = make("span", `type-badge ${item.kind}`, item.kind === "inline" ? t("inline") : t("pageComment"));
    header.append(title, type); card.append(header);
    const meta = make("div", "comment-meta");
    const author = displayAuthor(item.root);
    meta.textContent = `${author}${author ? " · " : ""}${dateValue(createdAt(item.root))}${item.replyCount ? ` · ${item.replyCount} ${t("replyCount")}` : ""}`;
    card.append(meta);
    const primaryComment = item.text;
    card.append(make("p", "comment-text", primaryComment || "(ohne Text)"));
    if (item.replyCount) card.append(make("p", "latest-reply", `${displayAuthor(item.last)}: ${bodyText(item.last.body)}`));
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
      state.comments = []; state.pages.clear(); state.users.clear(); state.drafts.clear(); state.expanded.clear();
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
  document.querySelectorAll(".tab").forEach(el => el.classList.toggle("active", el.dataset.page === name));
  document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === `page${name[0].toUpperCase()}${name.slice(1)}`));
}
function applyTheme() {
  const mode = state.settings.themeMode;
  document.documentElement.dataset.theme = mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
}
function createCommentLoadContext() { return { warnings: new Set(), pagesPromise: null }; }
async function loadPageComments(kind, context) {
  // Some Cloud sites return 404 for the global collection while page endpoints work.
  context.pagesPromise ??= getAll("/wiki/api/v2/pages?limit=100&status=current");
  const pages = await context.pagesPromise;
  const comments = new Map();
  await parallelMap(pages, async page => {
    state.pages.set(String(page.id), page);
    const resolution = kind === "inline" ? "&resolution-status=open,reopened,resolved,dangling" : "";
    let roots;
    try { roots = await getAll(`/wiki/api/v2/pages/${encodeURIComponent(page.id)}/${kind}-comments?limit=100&body-format=atlas_doc_format${resolution}`); }
    catch (error) {
      if (![403, 404].includes(error.status)) throw error;
      context.warnings.add(t("missingComments")); return;
    }
    let pending = roots.map(comment => ({ ...comment, pageId: String(page.id) }));
    while (pending.length) {
      const next = [];
      for (const comment of pending) {
        if (comments.has(String(comment.id))) continue;
        comments.set(String(comment.id), comment);
        try {
          const children = await getAll(`/wiki/api/v2/${kind}-comments/${encodeURIComponent(comment.id)}/children?limit=100&body-format=atlas_doc_format`);
          next.push(...children.map(child => ({ ...child, pageId: String(page.id), parentCommentId: String(comment.id) })));
        } catch (error) {
          if (![403, 404].includes(error.status)) throw error;
          context.warnings.add(t("missingComments"));
        }
      }
      pending = next;
    }
  });
  return [...comments.values()];
}
// Providers isolate comment loading/actions so tasks or notifications can be added later.
const commentSources = Object.fromEntries(["inline", "footer"].map(kind => [kind, {
  endpoint: `/wiki/api/v2/${kind}-comments`,
  async load(context = createCommentLoadContext()) {
    const endpoint = this.endpoint;
    let comments;
    try { comments = await getAll(`${endpoint}?limit=100&body-format=atlas_doc_format`); }
    catch (error) {
      if (error.status !== 404) throw error;
      comments = await loadPageComments(kind, context);
    }
    const byId = new Map(comments.map(c => [String(c.id), c]));
    // A collection can contain replies whose parent is outside the returned collection.
    const unavailableParents = new Set();
    let missing = [...new Set(comments.map(c => c.parentCommentId).filter(id => id && !byId.has(String(id))))];
    while (missing.length) {
      await parallelMap(missing, async id => {
        try {
          const parent = await api(`${endpoint}/${encodeURIComponent(id)}?body-format=atlas_doc_format`);
          byId.set(String(id), parent);
        } catch (error) {
          if (![403, 404].includes(error.status)) throw error;
          unavailableParents.add(String(id)); context.warnings.add(t("missingComments"));
        }
      });
      missing = [...new Set([...byId.values()].map(c => c.parentCommentId).filter(id => id && !byId.has(String(id)) && !unavailableParents.has(String(id))))];
    }
    await parallelMap([...byId.values()], async comment => {
      if (comment.version?.number > 1) {
        try {
          const original = await api(`${endpoint}/${encodeURIComponent(comment.id)}?version=1`);
          comment.authorId = authorId(original);
          comment.createdAt = createdAt(original);
        } catch (error) {
          if (![403, 404].includes(error.status)) throw error;
          // Older comment versions may not be available through v2 on this site.
          try {
            const content = await api(`/wiki/rest/api/content/${encodeURIComponent(comment.id)}?expand=history`);
            if (!content.history?.createdBy?.accountId) throw error;
            comment.authorId = content.history.createdBy.accountId;
            comment.createdAt = content.history.createdDate;
            state.users.set(comment.authorId, content.history.createdBy);
          } catch (historyError) {
            if (![403, 404].includes(historyError.status)) throw historyError;
            comment.authorId = ""; context.warnings.add(t("missingAuthors"));
          }
        }
      }
    });
    const threads = buildThreads([...byId.values()], kind).filter(item => item.mine || item.watched);
    await parallelMap([...new Set(threads.map(item => item.pageId).filter(Boolean))], async id => {
      if (!state.pages.has(id)) {
        try { state.pages.set(id, await api(`/wiki/api/v2/pages/${encodeURIComponent(id)}`)); }
        catch (error) { if (![403,404].includes(error.status)) throw error; }
      }
    });
    await parallelMap([...new Set(threads.flatMap(item => item.all.map(authorId)).filter(Boolean))], async id => {
      if (!state.users.has(id)) {
        try { state.users.set(id, await api(`/wiki/rest/api/user?accountId=${encodeURIComponent(id)}`)); }
        catch { state.users.set(id, { displayName: id }); }
      }
    });
    return threads.map(item => ({ ...item, pageTitle: state.pages.get(item.pageId)?.title ?? item.pageTitle }));
  },
  reply(item, text) {
    const value = JSON.stringify({ version: 1, type: "doc", content: text.split("\n").map(line => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) });
    return api(this.endpoint, { method: "POST", body: JSON.stringify({ parentCommentId: item.id, body: { representation: "atlas_doc_format", value } }) });
  },
  async resolve(item, resolved) {
    const current = await api(`${endpointFor(item)}/${encodeURIComponent(item.id)}?body-format=atlas_doc_format`);
    if (!current.body?.atlas_doc_format?.value || !current.version?.number) throw new Error(t("requestFailed"));
    return api(`${endpointFor(item)}/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify({
      version: { number: current.version.number + 1 },
      body: { representation: "atlas_doc_format", value: current.body.atlas_doc_format.value }, resolved
    }) });
  }
}]));
function endpointFor(item) { return commentSources[item.kind].endpoint; }
async function parallelMap(items, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  }));
}
function itemKey(item) { return `${state.settings.host}|${state.me?.accountId}|${item.kind}|${item.id}`; }
function fingerprint(item) { return item.all.map(c => `${c.id}:${c.version?.number ?? 1}`).sort().join(","); }
function displayAuthor(comment) { return state.users.get(authorId(comment))?.displayName ?? comment.author?.displayName ?? authorId(comment); }
function createCommentSection(item, section, label) {
  const key = `${itemKey(item)}|${section}`;
  const wrapper = make("div", "comment-section");
  const header = make("div", "comment-footer compact-actions");
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
    updateToggle();
  });
  header.append(toggle); wrapper.append(header, panel);
  return { wrapper, header, panel };
}
function appendConversation(card, item) {
  const key = itemKey(item);
  const conversation = createCommentSection(item, "conversation", `${t("conversation")} (${item.all.length})`);
  const actions = createCommentSection(item, "actions", t("actions"));
  const panel = actions.panel;
  const link = make("a", "open-link", t("openPage")); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
  const linkRow = make("div", "comment-footer comment-link-row");
  linkRow.append(link);
  const details = make("div", "conversation");
  for (const comment of [...item.all].sort((a,b) => new Date(createdAt(a)) - new Date(createdAt(b)))) {
    const entry = make("div", "conversation-entry");
    entry.append(make("div", "comment-meta", `${displayAuthor(comment)} · ${dateValue(createdAt(comment))}`), make("p", "", bodyText(comment.body)));
    details.append(entry);
  }
  conversation.panel.append(details);
  const form = make("form", "reply-form");
  const input = make("textarea", "reply-input"); input.rows = 2; input.required = true;
  input.placeholder = t("replyPlaceholder"); input.setAttribute("aria-label", t("replyPlaceholder"));
  input.value = state.drafts.get(key) ?? "";
  input.addEventListener("input", () => state.drafts.set(key, input.value));
  const send = make("button", "primary-button", t("sendReply")); send.type = "submit";
  const feedback = make("div", "action-feedback"); feedback.setAttribute("role", "status");
  const footer = make("div", "comment-footer");
  const done = !item.open || state.dismissed[key] === fingerprint(item);
  const resolve = make("button", "secondary-button", t(done ? "reopen" : item.kind === "inline" ? "resolve" : "dismiss")); resolve.type = "button";
  footer.append(resolve);
  async function perform(action) {
    if (state.busy.has(key) || state.loading) return;
    state.busy.add(key); send.disabled = resolve.disabled = input.disabled = true; $("refreshButton").disabled = true;
    feedback.textContent = t("saving");
    try { await action(); feedback.textContent = ""; render(); }
    catch (error) { feedback.textContent = `${t("actionFailed")} (${error.status ?? error.message})`; }
    finally { state.busy.delete(key); send.disabled = resolve.disabled = input.disabled = false; $("refreshButton").disabled = state.busy.size > 0; }
  }
  form.addEventListener("submit", event => {
    event.preventDefault(); if (!input.value.trim()) return;
    perform(async () => {
      const reply = await commentSources[item.kind].reply(item, input.value.trim());
      item.all.push({ ...reply, authorId: state.me.accountId, createdAt: createdAt(reply) ?? new Date().toISOString() });
      item.last = item.all.at(-1); item.replyCount++; item.myComment = item.last; item.replied = true; item.watched = true;
      item.updatedAt = createdAt(item.last); state.drafts.delete(key);
    });
  });
  resolve.addEventListener("click", () => perform(async () => {
    if (item.kind === "inline") {
      await commentSources.inline.resolve(item, !done); item.open = done;
    } else {
      const dismissed = { ...state.dismissed };
      if (done) delete dismissed[key]; else dismissed[key] = fingerprint(item);
      await storage.set({ dismissed }); state.dismissed = dismissed;
    }
  }));
  send.disabled = resolve.disabled = input.disabled = state.busy.has(key);
  form.append(input, send); panel.append(form, feedback, footer);
  card.append(linkRow, conversation.wrapper, actions.wrapper);
}
Object.assign(i18n.de, {
  actions: "Aktionen",
  loadHints: "Hinweise zur Übersicht",
  partialResults: "Die Übersicht ist unvollständig.", missingComments: "Einzelne Seiten oder Kommentare sind nicht mehr zugänglich.", missingAuthors: "Einzelne ursprüngliche Autoren konnten nicht ermittelt werden.",
  all: "Alle", done: "Erledigt", conversation: "Verlauf", replyPlaceholder: "Antwort schreiben …", sendReply: "Antwort senden",
  resolve: "In Confluence erledigen", dismiss: "Lokal erledigen", reopen: "Wieder öffnen", saving: "Wird gespeichert …",
  actionFailed: "Aktion fehlgeschlagen. Bitte erneut versuchen.",
  footerNote: "Inline: Status in Confluence. Seitenkommentare: lokal erledigt; neue Antworten oder Änderungen öffnen sie wieder.",
  noAccess: "Keine relevanten Kommentare vorhanden."
});
Object.assign(i18n.en, {
  actions: "Actions",
  loadHints: "Overview notes",
  partialResults: "The overview is incomplete.", missingComments: "Some pages or comments are no longer accessible.", missingAuthors: "Some original authors could not be retrieved.",
  all: "All", done: "Done", conversation: "Conversation", replyPlaceholder: "Write a reply …", sendReply: "Send reply",
  resolve: "Resolve in Confluence", dismiss: "Done locally", reopen: "Reopen", saving: "Saving …",
  actionFailed: "Action failed. Please try again.",
  footerNote: "Inline: Confluence status. Page comments: completed locally; new replies or edits reopen them.",
  noAccess: "No relevant comments found."
});
async function init() {
  const stored = await storage.get(["settings", "dismissed"]); state.dismissed = stored.dismissed ?? {}; state.settings = { ...defaults.settings, ...(stored.settings ?? {}) };
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
      if (state.pageNavigationVersion === pageNavigationVersion) activatePage("comments");
      await loadComments();
    } catch (error) {
      state.me = null; updateConnectionState(false);
      showNotice(error.status === 401 ? t("authFailed") : `${t("loginFailed")} ${error.message}`, "error");
    }
  }
}
init().catch(error => { console.error(error); showNotice(error.message, "error"); });
