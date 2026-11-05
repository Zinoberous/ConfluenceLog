// Shared by the popup and the Manifest V3 background worker. No UI dependencies.
function createConfluenceClient(state, t = key => key, lang = () => "en") {
  state.originals ??= new Map();
function originOf(host) { return new URL(host).origin; }
function authHeader() { return "Basic " + btoa(`${state.settings.email}:${state.settings.token}`); }
function safeNextUrl(next) {
  const url = new URL(next, `${state.settings.host}/wiki/`);
  if (/^\/(?:api\/v2|rest\/api)(?:\/|$)/.test(url.pathname)) url.pathname = `/wiki${url.pathname}`;
  if (url.origin !== originOf(state.settings.host)) throw new Error("API lieferte einen Link außerhalb des konfigurierten Hosts.");
  return url.href;
}
async function api(pathOrUrl, options = {}) {
  if (options.method && options.method !== "GET") throw new Error("readOnly");
  const url = pathOrUrl.startsWith("http") ? safeNextUrl(pathOrUrl) : `${state.settings.host}${pathOrUrl}`;
  const response = await fetch(url, { ...options, redirect: "error", signal: options.signal ?? AbortSignal.timeout(25000), headers: { Accept: "application/json", Authorization: authHeader(), ...(options.body ? { "Content-Type": "application/json" } : {}) } });
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
function htmlText(value) {
  return String(value).replace(/<[^>]*>/g, " ").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
function bodyText(body) {
  if (!body) return "";
  if (typeof body === "string") return htmlText(body).replace(/\s+/g, " ").trim();
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
  if (typeof raw === "string") { try { root = JSON.parse(raw); } catch { return [...raw.matchAll(/(?:ri:account-id|data-account-id)\s*=\s*(["'])(.*?)\1/gi)].some(match => htmlText(match[2]) === accountId); } }
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
function dateValue(value) { const d = new Date(value ?? 0); return Number.isNaN(d.getTime()) ? "" : [new Intl.DateTimeFormat(lang(), { dateStyle: "medium" }).format(d), new Intl.DateTimeFormat(lang(), { timeStyle: "short" }).format(d)].join(" "); }
function isOpen(comment, kind) {
  const status = String(comment.resolutionStatus ?? comment.status ?? "").toLowerCase();
  return comment.resolved !== true && !["resolved", "closed", "done"].includes(status);
}
function filterOpenComments(comments, kind) {
  const byId = new Map(comments.map(comment => [String(comment.id), comment]));
  return comments.filter(comment => {
    const visited = new Set();
    let current = comment;
    while (current) {
      if (!isOpen(current, kind) || visited.has(String(current.id))) return false;
      visited.add(String(current.id));
      current = current.parentCommentId ? byId.get(String(current.parentCommentId)) : null;
    }
    return true;
  });
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
    const resolvedAt = !isOpen(root, kind) ? [root.resolutionLastModifiedAt, root.resolutionLastModifiedTime].find(value => Number.isFinite(Date.parse(value))) ?? null : null;
    const resolvedById = !isOpen(root, kind) ? root.resolutionLastModifierId ?? "" : "";
    return { id: String(root.id), kind, root, all, last, myComment, mine, mentioned, replied, watched, resolvedAt, resolvedById, pageId: String(pageId), pageTitle: page?.title ?? root.pageTitle ?? t("noPage"), url: pageUrl(pageId, myComment?.id ?? root.id), text: bodyText(root.body), updatedAt: createdAt(last) ?? createdAt(root), replyCount: Math.max(0, all.length - 1), open: isOpen(root, kind) };
  });
}
function createCommentLoadContext() { return { warnings: new Set(), pagesPromise: null }; }
async function loadPageComments(kind, context) {
  // Some Cloud sites return 404 for the global collection while page endpoints work.
  context.pagesPromise ??= getAll("/wiki/api/v2/pages?limit=250&status=current");
  const pages = await context.pagesPromise;
  const comments = new Map();
  await parallelMap(pages, async page => {
    state.pages.set(String(page.id), page);
    const resolution = kind === "inline" ? "&resolution-status=open,reopened,resolved,dangling" : "";
    let roots;
    try { roots = await getAll(`/wiki/api/v2/pages/${encodeURIComponent(page.id)}/${kind}-comments?limit=250&body-format=atlas_doc_format${resolution}`); }
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
          const children = await getAll(`/wiki/api/v2/${kind}-comments/${encodeURIComponent(comment.id)}/children?limit=250&body-format=atlas_doc_format`);
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
// Providers isolate comment loading so tasks or notifications can be added later.
const commentSources = Object.fromEntries(["inline", "footer"].map(kind => [kind, {
  endpoint: `/wiki/api/v2/${kind}-comments`,
  async load(context = createCommentLoadContext()) {
    const endpoint = this.endpoint;
    let comments;
    try { comments = await getAll(`${endpoint}?limit=250&body-format=atlas_doc_format`); }
    catch (error) {
      if (error.status !== 404) throw error;
      comments = await loadPageComments(kind, context);
    }
    const byId = new Map(comments.map(c => [String(c.id), c]));
    // A collection can contain replies whose parent is outside the returned collection.
    const unavailableParents = new Set();
    let missing = [...new Set([...byId.values()].map(c => c.parentCommentId).filter(id => id && !byId.has(String(id))))];
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
    const threadComments = [...byId.values()];
    await parallelMap(threadComments, async comment => {
      if (state.originals.has(String(comment.id))) {
        Object.assign(comment, state.originals.get(String(comment.id)));
      } else if (comment.version?.number > 1) {
        try {
          const original = await api(`${endpoint}/${encodeURIComponent(comment.id)}?version=1`);
          comment.authorId = authorId(original);
          comment.createdAt = createdAt(original);
          state.originals.set(String(comment.id), { authorId: comment.authorId, createdAt: comment.createdAt });
        } catch (error) {
          if (![403, 404].includes(error.status)) throw error;
          // Older comment versions may not be available through v2 on this site.
          try {
            const content = await api(`/wiki/rest/api/content/${encodeURIComponent(comment.id)}?expand=history`);
            if (!content.history?.createdBy?.accountId) throw error;
            comment.authorId = content.history.createdBy.accountId;
            comment.createdAt = content.history.createdDate;
            state.originals.set(String(comment.id), { authorId: comment.authorId, createdAt: comment.createdAt });
            state.users.set(comment.authorId, content.history.createdBy);
          } catch (historyError) {
            if (![403, 404].includes(historyError.status)) throw historyError;
            comment.authorId = ""; context.warnings.add(t("missingAuthors"));
          }
        }
      }
    });
    const threads = buildThreads(threadComments, kind).filter(item => item.mine || item.watched);
    await parallelMap([...new Set(threads.map(item => item.pageId).filter(Boolean))], async id => {
      if (!state.pages.has(id)) {
        try { state.pages.set(id, await api(`/wiki/api/v2/pages/${encodeURIComponent(id)}`)); }
        catch (error) { if (![403,404].includes(error.status)) throw error; }
      }
    });
    await parallelMap([...new Set(threads.flatMap(item => [...item.all.map(authorId), item.resolvedById]).filter(Boolean))], async id => {
      if (!state.users.has(id)) {
        try { state.users.set(id, await api(`/wiki/rest/api/user?accountId=${encodeURIComponent(id)}`)); }
        catch { state.users.set(id, { displayName: id }); }
      }
    });
    return threads.map(item => ({ ...item, pageTitle: state.pages.get(item.pageId)?.title ?? item.pageTitle }));
  }
}]));
async function parallelMap(items, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  }));
}
function itemKey(item) { return `${state.settings.host}|${state.me?.accountId}|${item.kind}|${item.id}`; }
function displayAuthor(comment) { return state.users.get(authorId(comment))?.displayName ?? comment.author?.displayName ?? authorId(comment); }

  function snapshot(warnings = []) {
    return {
      schema: 3, host: state.settings.host, email: state.settings.email, me: state.me,
      updatedAt: new Date(state.lastUpdated ?? Date.now()).toISOString(), revision: Date.now(),
      threads: state.comments.map(item => ({ kind: item.kind,
        comments: item.all.map(({ children, ...comment }) => comment) })),
      pages: [...state.pages], users: [...state.users], originals: [...state.originals], warnings,
      metadataAt: state.metadataAt ?? Date.now()
    };
  }
  function restore(cache) {
    if (!matchesConfluenceCache(cache, state.settings)) return false;
    state.me = cache.me; state.pages = new Map(cache.pages ?? []); state.users = new Map(cache.users ?? []);
    state.originals = new Map(cache.originals ?? []); state.metadataAt = cache.metadataAt;
    state.comments = cache.threads.flatMap(thread => buildThreads(thread.comments, thread.kind));
    state.lastUpdated = new Date(cache.updatedAt);
    return true;
  }
  return { originOf, authHeader, safeNextUrl, api, getAll, authorId, createdAt, bodyText, mentionsAccount, pageUrl, dateValue, isOpen, filterOpenComments, buildThreads, createCommentLoadContext, loadPageComments, parallelMap, itemKey, displayAuthor, commentSources, snapshot, restore };
}
function matchesConfluenceCache(cache, settings) {
  return cache?.schema === 3 && cache.host === settings.host && cache.email === settings.email &&
    Boolean(cache.me?.accountId) && Array.isArray(cache.threads) && Number.isFinite(Date.parse(cache.updatedAt));
}
