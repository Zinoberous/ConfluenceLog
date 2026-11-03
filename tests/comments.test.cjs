const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function app() {
  const calls = [];
  const context = vm.createContext({ chrome: { storage: { local: {} } }, navigator: { language: 'de' }, URL, Intl, console, btoa,
    fetch: async (url, options) => { calls.push({url, options}); return { ok: true, json: async () => ({ id: '1', version: { number: 3 }, body: { atlas_doc_format: { value: '{"type":"doc","content":[]}' } } }) }; }
  });
  vm.runInContext(fs.readFileSync('popup.js','utf8').replace(/init\(\)\.catch[\s\S]*$/, ''), context);
  vm.runInContext(`state.settings.host = 'https://example.atlassian.net'; state.me = {accountId:'me'};`, context);
  return { run: code => vm.runInContext(code, context), calls, set: (key, value) => { context[key] = value; } };
}
const body = text => ({ atlas_doc_format: { value: JSON.stringify({ type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}] }) } });
test('v2 authors and dates identify own replies and mention threads', () => {
  const a = app();
  const comments = [
    {id:'1',pageId:'9',version:{authorId:'other',createdAt:'2026-01-01'},body:body('Root')},
    {id:'2',parentCommentId:'1',version:{authorId:'me',createdAt:'2026-01-02'},body:body('My reply')},
    {id:'3',parentCommentId:'1',version:{authorId:'other',createdAt:'2026-01-03'},body:{atlas_doc_format:{value:JSON.stringify({type:'mention',attrs:{id:'me'}})}}}
  ];
  const thread = a.run(`buildThreads(${JSON.stringify(comments)}, 'inline')[0]`);
  assert.equal(thread.mine,false); assert.equal(thread.mentioned,true); assert.equal(thread.replied,true); assert.equal(thread.watched,true);
  assert.equal(thread.last.id,'3'); assert.equal(thread.replyCount,2); assert.match(thread.url,/focusedCommentId=2/);
});
test('resolved inline threads and local fingerprints track completion', () => {
  const a = app();
  assert.equal(a.run(`isOpen({resolutionStatus:'resolved'}, 'inline')`),false);
  assert.equal(a.run(`isOpen({}, 'footer')`),true);
  assert.notEqual(a.run(`fingerprint({all:[{id:'1',version:{number:1}}]})`),a.run(`fingerprint({all:[{id:'1',version:{number:2}}]})`));
  assert.notEqual(a.run(`fingerprint({all:[{id:'1'}]})`),a.run(`fingerprint({all:[{id:'1'},{id:'2'}]})`));
});
test('pagination accepts wiki-relative links and rejects foreign hosts', () => {
  const a = app();
  assert.equal(a.run(`safeNextUrl('/wiki/api/v2/inline-comments?cursor=a')`),'https://example.atlassian.net/wiki/api/v2/inline-comments?cursor=a');
  assert.throws(() => a.run(`safeNextUrl('https://evil.example/test')`));
});
test('reply uses parent ID and plain text ADF, resolve preserves fetched body/version', async () => {
  const a = app();
  await a.run(`commentSources.footer.reply({id:'42'}, '<script>hello</script>\\nNext')`);
  const sent = JSON.parse(a.calls[0].options.body);
  assert.equal(sent.parentCommentId,'42'); assert.equal(sent.body.representation,'atlas_doc_format');
  assert.equal(JSON.parse(sent.body.value).content[0].content[0].text,'<script>hello</script>');
  await a.run(`commentSources.inline.resolve({id:'42',kind:'inline'}, true)`);
  const update = JSON.parse(a.calls[2].options.body);
  assert.equal(a.calls[2].options.method,'PUT'); assert.equal(update.resolved,true); assert.equal(update.version.number,4);
  assert.equal(update.body.value,'{"type":"doc","content":[]}');
});

test('provider paginates and reconstructs parents, using original authors after edits', async () => {
  const a = app();
  a.run(`fetch = async url => ({ok:true, json:async () => {
    if (url.includes('cursor=next')) return {results:[]};
    if (url.includes('/inline-comments?')) return {results:[{id:'2',parentCommentId:'1',version:{number:2,authorId:'editor',createdAt:'2026-01-03'},body:{atlas_doc_format:{value:'{"type":"doc","content":[]}'}}}],_links:{next:'/wiki/api/v2/inline-comments?cursor=next'}};
    if (url.includes('/inline-comments/1')) return {id:'1',pageId:'9',version:{number:1,authorId:'other',createdAt:'2026-01-01'},body:{}};
    if (url.includes('/inline-comments/2?version=1')) return {id:'2',version:{number:1,authorId:'me',createdAt:'2026-01-02'}};
    if (url.includes('/pages/9')) return {id:'9',title:'Page title'};
    return {displayName:'User'};
  }});`);
  const threads = await a.run('commentSources.inline.load()');
  assert.equal(threads.length,1); assert.equal(threads[0].mine,false); assert.equal(threads[0].watched,true);
  assert.equal(threads[0].pageTitle,'Page title'); assert.equal(threads[0].all.length,2);
  assert.equal(threads[0].myComment.authorId,'me');
});

function mockFetch(a, route) {
  const calls = [];
  a.set('fetch', async url => {
    calls.push(url);
    const result = route(new URL(url));
    const status = result.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => result.data ?? {} };
  });
  return calls;
}
test('global 404 falls back to paginated pages and replies, preserving thread resolution', async () => {
  const a = app();
  const calls = mockFetch(a, url => {
    const path = url.pathname;
    if (path === '/wiki/api/v2/inline-comments') return {status:404};
    if (path === '/wiki/api/v2/pages') return {data: url.searchParams.has('cursor') ? {results:[{id:'10',title:'Deleted page'}]} : {results:[{id:'9',title:'Working page'}],_links:{next:'/api/v2/pages?cursor=next'}}};
    if (path === '/wiki/api/v2/pages/9/inline-comments') return {data:{results:[{id:'1',resolutionStatus:'resolved',version:{number:1,authorId:'other',createdAt:'2026-01-01'},body:body('Root')}]}};
    if (path === '/wiki/api/v2/pages/10/inline-comments') return {status:404};
    if (path === '/wiki/api/v2/inline-comments/1/children') return {data:{results:[{id:'2',version:{number:1,authorId:'me',createdAt:'2026-01-02'},body:body('Own reply')}]}};
    if (path === '/wiki/api/v2/inline-comments/2/children') return {data:{results:[]}};
    if (path === '/wiki/rest/api/user') return {data:{displayName:'User'}};
    throw new Error('Unexpected request: '+url);
  });
  a.run('globalThis.loadContext = createCommentLoadContext()');
  const threads = await a.run('commentSources.inline.load(loadContext)');
  assert.equal(threads.length,1); assert.equal(threads[0].mine,false); assert.equal(threads[0].watched,true); assert.equal(threads[0].replyCount,1);
  assert.equal(threads[0].open,false); assert.equal(threads[0].pageTitle,'Working page');
  assert.equal(a.run('loadContext.warnings.size'),1);
  assert.ok(calls.some(url => url.includes('/wiki/api/v2/pages?cursor=next')));
});
test('404 on an old version uses content history without losing the thread', async () => {
  const a = app();
  mockFetch(a, url => {
    if (url.pathname === '/wiki/api/v2/footer-comments') return {data:{results:[{id:'1',pageId:'9',version:{number:2,authorId:'editor'},body:body('Edited')}]}};
    if (url.pathname === '/wiki/api/v2/footer-comments/1') return {status:404};
    if (url.pathname === '/wiki/rest/api/content/1') return {data:{history:{createdBy:{accountId:'me',displayName:'Me'},createdDate:'2026-01-01'}}};
    if (url.pathname === '/wiki/api/v2/pages/9') return {data:{id:'9',title:'Page'}};
    throw new Error('Unexpected request: '+url);
  });
  const threads = await a.run('commentSources.footer.load()');
  assert.equal(threads.length,1); assert.equal(threads[0].mine,true);
  assert.equal(threads[0].root.authorId,'me'); assert.equal(threads[0].root.createdAt,'2026-01-01');
});
test('a missing parent does not abort other accessible comment threads', async () => {
  const a = app();
  mockFetch(a, url => {
    if (url.pathname === '/wiki/api/v2/footer-comments') return {data:{results:[{id:'1',version:{number:1,authorId:'me'},body:body('Own')},{id:'2',parentCommentId:'deleted',version:{number:1,authorId:'other'},body:body('Reply')}]}};
    if (url.pathname === '/wiki/api/v2/footer-comments/deleted') return {status:404};
    if (url.pathname === '/wiki/rest/api/user') return {data:{displayName:'Me'}};
    throw new Error('Unexpected request: '+url);
  });
  const threads = await a.run('commentSources.footer.load()');
  assert.equal(threads.length,1); assert.equal(threads[0].id,'1');
});
test('errors contain the failing API path and authentication does not trigger a page scan', async () => {
  const a = app();
  const calls = mockFetch(a, () => ({status:401}));
  await assert.rejects(a.run('commentSources.inline.load()'), /HTTP 401.*GET \/wiki\/api\/v2\/inline-comments/);
  assert.equal(calls.length,1);
});
test('loading and connection notices belong to their respective pages', () => {
  const html = fs.readFileSync('popup.html','utf8');
  const comments = html.match(/<section id="pageComments"[\s\S]*?<\/section>/)[0];
  const settings = html.match(/<section id="pageSettings"[\s\S]*?<\/section>/)[0];
  assert.match(comments,/id="notice"/); assert.doesNotMatch(settings,/id="notice"/);
  assert.match(settings,/id="settingsNotice"/);
  const a = app();
  const nodes = {notice:{},settingsNotice:{}};
  a.set('document',{getElementById: id => nodes[id]});
  a.run('showNotice("Login failed", "error")');
  assert.equal(nodes.settingsNotice.textContent,'Login failed'); assert.equal(nodes.notice.textContent,undefined);
  a.run('showNotice("Comment request failed", "error", "comments")');
  assert.equal(nodes.notice.textContent,'Comment request failed'); assert.equal(nodes.settingsNotice.textContent,'Login failed');
});
function popupDocument(a) {
  function element(tagName) {
    return { tagName, listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
      children: [], attributes: {}, className: '', textContent: '', open: false,
      classList: { toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }
    };
  }
  const nodes = new Map();
  a.set('document', { createElement: element, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  }});
  return id => nodes.get(id);
}
for (const fails of [false, true]) {
  test(`filter changes preserve loading until requests ${fails ? 'fail' : 'complete'}`, async () => {
    const a = app();
    const node = popupDocument(a);
    let finish;
    a.set('pendingComments', new Promise((resolve, reject) => {
      finish = () => fails ? reject(new Error('Test load failure')) : resolve([]);
    }));
    a.set('console', { error() {} });
    a.run(`state.settings.email = 'me@example.com'; state.settings.token = 'test';
      commentSources.inline.load = () => pendingComments;
      commentSources.footer.load = () => pendingComments;`);
    const loading = a.run('loadComments()');
    for (const filter of ['watched', 'mine', 'done', 'all']) {
      a.run(`state.activeTab = '${filter}'; state.kind = 'inline'; state.query = 'search'; render();`);
      assert.equal(node('commentList').attributes['aria-busy'], 'true');
      assert.equal(node('commentList').children[0].className, 'empty loading-state');
      assert.equal(node('commentList').children[0].children[1].textContent, 'Lade Kommentare …');
    }
    finish();
    await loading;
    assert.equal(node('commentList').attributes['aria-busy'], 'false');
    assert.equal(node('commentList').children[0].className, 'empty');
    assert.equal(node('refreshButton').disabled, false);
    assert.equal(a.run('state.activeTab'), 'all');
    if (fails) assert.match(node('notice').textContent, /Test load failure/);
  });
}

test('conversation and actions expand independently and retain state and drafts', () => {
  const a = app();
  const node = popupDocument(a);
  a.run(`state.comments = buildThreads([{id:'1',pageId:'9',version:{number:1,authorId:'me',createdAt:'2026-01-01'},body:{}}], 'inline'); render();`);
  const card = node('commentList').children[0];
  const conversation = card.children.at(-2), actions = card.children.at(-1);
  const conversationToggle = conversation.children[0].children[0];
  const actionsToggle = actions.children[0].children[0];
  assert.match(conversationToggle.textContent, /Verlauf/);
  assert.match(actionsToggle.textContent, /Aktionen/);
  assert.equal(conversation.children[1].hidden,true);
  assert.equal(actions.children[1].hidden,true);
  assert.equal(card.children.at(-3).children[0].tagName,'a');
  assert.equal(conversation.children[0].children.length,1);
  conversationToggle.listeners.click();
  assert.equal(conversation.children[1].hidden,false);
  assert.equal(actions.children[1].hidden,true);
  actionsToggle.listeners.click();
  conversationToggle.listeners.click();
  assert.equal(conversation.children[1].hidden,true);
  assert.equal(actions.children[1].hidden,false);
  const input = actions.children[1].children[0].children[0];
  input.value = 'Draft reply'; input.listeners.input();
  a.run('render()');
  const refreshed = node('commentList').children[0];
  assert.equal(refreshed.children.at(-2).children[1].hidden,true);
  assert.equal(refreshed.children.at(-1).children[1].hidden,false);
  assert.equal(refreshed.children.at(-1).children[1].children[0].children[0].value,'Draft reply');
  assert.equal(refreshed.children.at(-1).children[1].children.at(-1).children[0].textContent,'In Confluence erledigen');
});

test('My comments contains only own roots; Watching includes own replies and mentions', () => {
  const a = app();
  const node = popupDocument(a);
  a.run(`state.comments = buildThreads([
    {id:'own',pageTitle:'Own thread',version:{authorId:'me'},body:{}},
    {id:'replied',pageTitle:'Replied thread',version:{authorId:'other'},body:{}},
    {id:'reply',parentCommentId:'replied',version:{authorId:'me'},body:{}},
    {id:'mentioned',pageTitle:'Mentioned thread',version:{authorId:'other'},body:{atlas_doc_format:{value:JSON.stringify({type:'mention',attrs:{id:'me'}})}}},
    {id:'unrelated',pageTitle:'Unrelated thread',version:{authorId:'other'},body:{}}
  ], 'inline').filter(item => item.mine || item.watched);`);
  const titles = () => node('commentList').children.map(card => card.children[0].children[0].children[0].textContent);
  a.run(`state.activeTab = 'mine'; render()`);
  assert.deepEqual(titles(),['Own thread']);
  a.run(`state.activeTab = 'watched'; render()`);
  assert.deepEqual(titles(),['Replied thread','Mentioned thread']);
  a.run(`state.activeTab = 'all'; render()`);
  assert.equal(titles().length,3);
  assert.equal(a.run(`state.comments.find(item => item.id === 'own').watched`),false);
});
test('replying from the popup adds Watching without changing the original ownership', async () => {
  const a = app();
  const node = popupDocument(a);
  a.run(`state.comments = buildThreads([{id:'1',version:{number:1,authorId:'other'},body:{atlas_doc_format:{value:JSON.stringify({type:'mention',attrs:{id:'me'}})}}}], 'inline');
    commentSources.inline.reply = async () => ({id:'2',version:{number:1}}); render();`);
  const form = node('commentList').children[0].children.at(-1).children[1].children[0];
  form.children[0].value = 'My reply';
  form.listeners.submit({preventDefault(){}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.run('state.comments[0].mine'),false);
  assert.equal(a.run('state.comments[0].replied'),true);
  assert.equal(a.run('state.comments[0].watched'),true);
});
