const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function app() {
  const calls = [];
  const context = vm.createContext({ chrome: { storage: { local: {} } }, navigator: { language: 'de' }, URL, Intl, console, btoa, AbortSignal,
    fetch: async (url, options) => { calls.push({url, options}); return { ok: true, json: async () => ({ id: '1', version: { number: 3 }, body: { atlas_doc_format: { value: '{"type":"doc","content":[]}' } } }) }; }
  });
  vm.runInContext(fs.readFileSync('confluence.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('popup.js','utf8').replace(/init\(\)\.catch[\s\S]*$/, ''), context);
  vm.runInContext(`state.settings.host = 'https://example.atlassian.net'; state.me = {accountId:'me'};`, context);
  vm.runInContext(`chrome.runtime = {sendMessage: async message => {
    if (message.action === 'refresh') {
      const context = createCommentLoadContext();
      state.comments = await commentSources.inline.load(context); state.lastUpdated = new Date();
      return {ok:true,value:dataClient.snapshot([...context.warnings])};
    }
    return {ok:false,error:{message:"readOnly"}};
  }};`, context);
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
test('Confluence resolution determines completion for both comment types', () => {
  const a = app();
  assert.equal(a.run(`isOpen({resolutionStatus:'resolved'}, 'inline')`),false);
  assert.equal(a.run(`isOpen({}, 'footer')`),true);
  assert.equal(a.run(`isOpen({resolutionStatus:'resolved'}, 'footer')`),false);
  assert.equal(a.run(`isOpen({resolutionStatus:'reopened'}, 'footer')`),true);
});
test('pagination accepts wiki-relative links and rejects foreign hosts', () => {
  const a = app();
  assert.equal(a.run(`safeNextUrl('/wiki/api/v2/inline-comments?cursor=a')`),'https://example.atlassian.net/wiki/api/v2/inline-comments?cursor=a');
  assert.throws(() => a.run(`safeNextUrl('https://evil.example/test')`));
});
test('comment clients expose no writes and reject mutation requests', async () => {
  const a = app();
  for (const kind of ['inline','footer']) {
    assert.equal(a.run(`commentSources.${kind}.reply`),undefined);
    assert.equal(a.run(`commentSources.${kind}.resolve`),undefined);
  }
  await assert.rejects(a.run(`api('/wiki/api/v2/inline-comments', {method:'POST'})`),/readOnly/);
  assert.equal(a.calls.length,0);
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
    if (path === '/wiki/api/v2/pages/9/inline-comments') return {data:{results:[{id:'1',resolutionStatus:'open',version:{number:1,authorId:'other',createdAt:'2026-01-01'},body:body('Root')}]}};
    if (path === '/wiki/api/v2/pages/10/inline-comments') return {status:404};
    if (path === '/wiki/api/v2/inline-comments/1/children') return {data:{results:[{id:'2',version:{number:1,authorId:'me',createdAt:'2026-01-02'},body:body('Own reply')}]}};
    if (path === '/wiki/api/v2/inline-comments/2/children') return {data:{results:[]}};
    if (path === '/wiki/rest/api/user') return {data:{displayName:'User'}};
    throw new Error('Unexpected request: '+url);
  });
  a.run('globalThis.loadContext = createCommentLoadContext()');
  const threads = await a.run('commentSources.inline.load(loadContext)');
  assert.equal(threads.length,1); assert.equal(threads[0].mine,false); assert.equal(threads[0].watched,true); assert.equal(threads[0].replyCount,1);
  assert.equal(threads[0].open,true); assert.equal(threads[0].pageTitle,'Working page');
  assert.equal(a.run('loadContext.warnings.size'),1);
  assert.ok(calls.some(url => url.includes('/wiki/api/v2/pages?cursor=next')));
});
test('404 on an old version uses content history without losing the thread', async () => {
  const a = app();
  mockFetch(a, url => {
    if (url.pathname === '/wiki/api/v2/inline-comments') return {data:{results:[{id:'1',pageId:'9',version:{number:2,authorId:'editor'},body:body('Edited')}]}};
    if (url.pathname === '/wiki/api/v2/inline-comments/1') return {status:404};
    if (url.pathname === '/wiki/rest/api/content/1') return {data:{history:{createdBy:{accountId:'me',displayName:'Me'},createdDate:'2026-01-01'}}};
    if (url.pathname === '/wiki/api/v2/pages/9') return {data:{id:'9',title:'Page'}};
    throw new Error('Unexpected request: '+url);
  });
  const threads = await a.run('commentSources.inline.load()');
  assert.equal(threads.length,1); assert.equal(threads[0].mine,true);
  assert.equal(threads[0].root.authorId,'me'); assert.equal(threads[0].root.createdAt,'2026-01-01');
});
test('a missing parent does not abort other accessible comment threads', async () => {
  const a = app();
  mockFetch(a, url => {
    if (url.pathname === '/wiki/api/v2/inline-comments') return {data:{results:[{id:'1',version:{number:1,authorId:'me'},body:body('Own')},{id:'2',parentCommentId:'deleted',version:{number:1,authorId:'other'},body:body('Reply')}]}};
    if (url.pathname === '/wiki/api/v2/inline-comments/deleted') return {status:404};
    if (url.pathname === '/wiki/rest/api/user') return {data:{displayName:'Me'}};
    throw new Error('Unexpected request: '+url);
  });
  const threads = await a.run('commentSources.inline.load()');
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
  a.set('document', { body: element(), querySelectorAll: () => [], createElement: element, getElementById(id) {
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
      commentSources.inline.load = () => pendingComments;`);
    const loading = a.run('loadComments()');
    for (const filter of ['watched', 'mine']) {
      a.run(`state.activeTab = '${filter}'; state.kind = 'inline'; state.query = 'search'; render();`);
      assert.equal(node('commentList').attributes['aria-busy'], 'true');
      assert.equal(node('commentList').children[0].className, 'empty loading-state');
      assert.equal(node('commentList').children[0].children[1].textContent, 'Lade Kommentare …');
    }
    finish();
    await loading;
    assert.equal(node('commentList').attributes['aria-busy'], 'false');
    assert.equal(node('commentList').children[0].className, 'empty');
    assert.equal(a.run('state.activeTab'), 'mine');
    if (fails) assert.match(node('notice').textContent, /Test load failure/);
  });
}

test('reply expander includes only replies and retains its open state', () => {
  const a = app(); const node = popupDocument(a);
  a.run(`state.comments = buildThreads([{id:'1',pageId:'9',version:{authorId:'me'},body:{atlas_doc_format:{value:JSON.stringify({type:'text',text:'Root text'})}}},{id:'2',parentCommentId:'1',version:{authorId:'other'},body:{atlas_doc_format:{value:JSON.stringify({type:'text',text:'Reply text'})}}}], 'footer'); render();`);
  const card = node('commentList').children[0];
  const conversation = card.children.at(-1);
  assert.equal(card.children.at(-2).children[0].tagName,'a');
  assert.equal(conversation.children[1].hidden,true);
  assert.match(conversation.children[0].children[0].textContent,/Antworten \(1\)/);
  assert.equal(conversation.children[1].children[0].children.length,1);
  assert.equal(conversation.children[1].children[0].children[0].children[1].textContent,'Reply text');
  assert.equal(card.children[2].textContent,'Root text');
  conversation.children[0].children[0].listeners.click();
  a.run('render()');
  assert.equal(node('commentList').children[0].children.at(-1).children[1].hidden,false);
  const tags = element => [element.tagName,...element.children.flatMap(tags)];
  assert.ok(!tags(node('commentList')).some(tag => ['form','textarea'].includes(tag)));
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
  assert.equal(a.run(`state.comments.find(item => item.id === 'own').watched`),false);
});
for (const kind of ['inline','footer']) {
  test(`${kind}: resolved conversations load with metadata and replies`, async () => {
    const a=app();
    mockFetch(a,url=> {
      if (url.pathname===`/wiki/api/v2/${kind}-comments`) return {data:{results:[
        {id:'1',pageId:'9',resolutionStatus:'resolved',version:{number:1,authorId:'me'},body:body('Root')},
        {id:'2',parentCommentId:'1',version:{number:1,authorId:'other'},body:body('Reply')}
      ]}};
      if (url.pathname==='/wiki/api/v2/pages/9') return {data:{id:'9',title:'Page'}};
      if (url.pathname==='/wiki/rest/api/user') return {data:{displayName:'User'}};
      throw new Error('Unexpected path: '+url);
    });
    const threads=await a.run(`commentSources.${kind}.load()`);
    assert.equal(threads.length,1); assert.equal(threads[0].open,false);
    assert.equal(threads[0].replyCount,1); assert.equal(threads[0].pageTitle,'Page');
  });
}
test('page fallback loads resolved roots and their replies', async () => {
  const a=app();
  mockFetch(a,url=>{
    if (url.pathname==='/wiki/api/v2/inline-comments') return {status:404};
    if (url.pathname==='/wiki/api/v2/pages') return {data:{results:[{id:'9',title:'Page'}]}};
    if (url.pathname==='/wiki/api/v2/pages/9/inline-comments') {
      assert.equal(url.searchParams.get('resolution-status'),'open,reopened,resolved,dangling');
      return {data:{results:[{id:'1',resolutionStatus:'resolved',version:{number:1,authorId:'me'},body:{}}]}};
    }
    if (url.pathname==='/wiki/api/v2/inline-comments/1/children') return {data:{results:[{id:'2',version:{number:1,authorId:'other'},body:{}}]}};
    if (url.pathname==='/wiki/api/v2/inline-comments/2/children') return {data:{results:[]}};
    if (url.pathname==='/wiki/rest/api/user') return {data:{displayName:'User'}};
    throw new Error('Unexpected path: '+url);
  });
  const threads=await a.run('commentSources.inline.load()');
  assert.equal(threads[0].open,false); assert.equal(threads[0].replyCount,1);
});

test('both comment types are enabled and have a type filter', () => {
  const a=app(); assert.equal(a.run('Object.keys(commentSources).join()'),'inline,footer');
  assert.match(fs.readFileSync('popup.html','utf8'),/value="footer"/);
});

test('cached results render immediately and stay visible while refreshing', async () => {
  const a = app();
  const node = popupDocument(a);
  a.run(`state.comments = buildThreads([{id:'1',pageId:'9',version:{authorId:'me'},body:{}}], 'inline'); state.lastUpdated = new Date(); globalThis.cached = dataClient.snapshot(); state.comments = []; state.me = null;`);
  assert.equal(a.run('applyCommentCache(cached)'),true);
  assert.equal(node('commentList').children[0].className,'comment-card');
  assert.equal(a.calls.length,0);
  let finish;
  a.set('pendingComments',new Promise(resolve => {finish=resolve;}));
  a.run(`state.settings.email='me@example.com'; state.settings.token='test'; commentSources.inline.load = () => pendingComments`);
  const loading=a.run('loadComments(false)');
  a.run('render()');
  assert.equal(node('commentList').children[0].className,'comment-card');
  assert.equal(node('commentList').attributes['aria-busy'],'true');
  finish([]); await loading;
  assert.equal(node('commentList').attributes['aria-busy'],'false');
});
test('cache restoration is account-scoped and session view retains filters without credentials', () => {
  const a=app(); popupDocument(a);
  a.run(`state.comments=[]; state.lastUpdated=new Date(); globalThis.cached=dataClient.snapshot();`);
  a.run(`cached.host='https://other.atlassian.net'`);
  assert.equal(a.run('applyCommentCache(cached)'),false);
  let saved;
  a.set('saveView', value => {saved=value; return Promise.resolve();});
  a.run(`chrome.storage.session={set:saveView}; state.query='Search'; state.kind='footer'; state.expanded.add('thread|conversation'); persistView();`);
  assert.equal(saved.commentView.query,'Search');
  assert.equal(saved.commentView.kind,'footer');
  assert.equal(saved.commentView.drafts,undefined);
  assert.doesNotMatch(JSON.stringify(saved),/token|Authorization/);
});

test('entries without replies have no expander and preserve the complete root text', () => {
  const a=app(); const node=popupDocument(a);
  const text='Long comment '.repeat(300);
  a.run(`state.comments=buildThreads([{id:'1',version:{authorId:'me'},body:${JSON.stringify(body(text))}}],'inline'); render()`);
  const card=node('commentList').children[0];
  assert.equal(card.children[2].textContent,text.trim());
  assert.ok(!card.children.some(child=>child.className==='comment-section'));
  assert.equal(card.children.at(-1).children[0].tagName,'a');
});

test('Done shows only resolved conversations and excludes them from the open count', () => {
  const a=app(); const node=popupDocument(a);
  a.run(`state.comments=buildThreads([{id:'1',pageTitle:'Open',resolutionStatus:'open',version:{authorId:'me'},body:{}},{id:'2',pageTitle:'Resolved',resolutionStatus:'resolved',version:{authorId:'me'},body:{}}],'inline'); render()`);
  const title=()=>node('commentList').children[0].children[0].children[0].children[0].textContent;
  assert.equal(title(),'Open'); assert.equal(node('openCount').textContent,1);
  a.run(`state.activeTab='done'; render()`);
  assert.equal(title(),'Resolved'); assert.equal(node('openCount').textContent,1);
  a.run(`state.lastUpdated=new Date(); globalThis.cache=dataClient.snapshot(); state.comments=[]; applyCommentCache(cache)`);
  assert.equal(a.run('state.comments.length'),2); assert.equal(title(),'Resolved');
});

test('scroll position survives reopening, rerenders and clicking a Confluence link', () => {
  const a=app(); const node=popupDocument(a);
  const frames=[];
  const browser={scrollY:0,requestAnimationFrame:callback=>frames.push(callback),scrollTo(x,y){this.scrollY=y;}};
  a.set('window',browser);
  let saved;
  a.set('saveView',value=>{saved=value;return Promise.resolve();});
  a.run(`chrome.storage.session={set:saveView}; state.comments=buildThreads([{id:'1',pageId:'9',version:{authorId:'me'},body:{}}],'inline');
    state.scrollTop=850; state.activePage='settings'; activatePage('comments'); render();`);
  while(frames.length) frames.shift()();
  assert.equal(browser.scrollY,850);
  a.run('render()'); browser.scrollY=0;
  while(frames.length) frames.shift()();
  assert.equal(browser.scrollY,850);
  browser.scrollY=920;
  node('commentList').children[0].children.at(-1).children[0].listeners.click();
  assert.equal(saved.commentView.scrollTop,920);
  a.run(`state.activePage='settings'; rememberScroll();`);
  browser.scrollY=0; a.run('rememberScroll()');
  assert.equal(a.run('state.scrollTop'),920);
});

test('Done sorts by resolution time, placing missing or invalid timestamps last', () => {
  const a=app(); const node=popupDocument(a);
  a.run(`state.comments=buildThreads([
    {id:'1',pageTitle:'Older resolution',resolutionStatus:'resolved',resolutionLastModifiedAt:'2026-10-01',version:{authorId:'me',createdAt:'2026-11-04'},body:{}},
    {id:'2',pageTitle:'Newest resolution',resolutionStatus:'resolved',resolutionLastModifiedTime:'2026-11-03',version:{authorId:'me',createdAt:'2026-01-01'},body:{}},
    {id:'3',pageTitle:'Missing timestamp',resolutionStatus:'resolved',resolutionLastModifiedAt:'invalid',version:{authorId:'me',createdAt:'2026-11-05'},body:{}}
  ],'footer'); state.activeTab='done'; render()`);
  const titles=node('commentList').children.map(card=>card.children[0].children[0].children[0].textContent);
  assert.deepEqual(titles,['Newest resolution','Older resolution','Missing timestamp']);
  assert.match(node('commentList').children[0].children[1].textContent,/Erledigt:/);
  assert.doesNotMatch(fs.readFileSync('popup.html','utf8'),/data-filter="all"/);
});
for (const kind of ['inline','footer']) {
  test(`${kind}: Done shows the resolver independently of the comment author or timestamp`, async () => {
    const a=app(); const node=popupDocument(a);
    const calls=mockFetch(a,url=>{
      if (url.pathname===`/wiki/api/v2/${kind}-comments`) return {data:{results:[{id:'1',resolutionStatus:'resolved',resolutionLastModifierId:'closer',version:{number:1,authorId:'me'},body:{}}]}};
      if (url.pathname==='/wiki/rest/api/user') return {data:{displayName:url.searchParams.get('accountId')==='closer'?'Resolver Name':'Author Name'}};
      throw new Error('Unexpected request: '+url);
    });
    await a.run(`(async () => {state.comments=await commentSources.${kind}.load(); state.activeTab='done'; render();})()`);
    const meta=node('commentList').children[0].children[1].textContent;
    assert.match(meta,/Erledigt/);
    const resolver=node('commentList').children[0].children[1].children[0];
    assert.equal(resolver.tagName,'strong'); assert.equal(resolver.textContent,' von Resolver Name');
    assert.match(meta,/Author Name/);
    assert.equal(calls.filter(url=>new URL(url).searchParams.get('accountId')==='closer').length,1);
    a.run(`state.comments[0].resolvedById='me'; render()`);
    assert.equal(node('commentList').children[0].children[1].children.length,0);
    a.run(`state.comments[0].resolvedById=''; render()`);
    assert.doesNotMatch(node('commentList').children[0].children[1].textContent,/Erledigt von/);
  });
}
test('JiraLog Easter eggs retain their click thresholds and alternative themes', () => {
  const a=app(); const node=popupDocument(a);
  let timeout;
  a.set('setTimeout',callback=>{timeout=callback;return 1;}); a.set('clearTimeout',()=>{});
  a.run(`document.documentElement={dataset:{theme:'dark'}}; setupEasterEggs()`);
  let logoHidden=false, emojiHidden=true;
  node('brandLogo').classList.toggle=(name,hidden)=>{logoHidden=hidden;};
  node('brandEmoji').classList.toggle=(name,hidden)=>{emojiHidden=hidden;};
  for(let i=0;i<9;i++) node('brandLogo').listeners.click();
  assert.equal(logoHidden,false); node('brandLogo').listeners.click();
  assert.equal(logoHidden,true); assert.equal(emojiHidden,false);
  for(let i=0;i<4;i++) node('tabInfo').listeners.click();
  assert.equal(a.run('document.documentElement.dataset.theme'),'dark');
  timeout(); node('tabInfo').listeners.click();
  assert.equal(a.run('document.documentElement.dataset.theme'),'dark');
  for(let i=0;i<4;i++) node('tabInfo').listeners.click();
  assert.equal(a.run('document.documentElement.dataset.theme'),'dark-alt');
  a.run(`document.documentElement.dataset.theme='light'`);
  for(let i=0;i<5;i++) node('tabInfo').listeners.click();
  assert.equal(a.run('document.documentElement.dataset.theme'),'light-alt');
});
test('search Easter egg is case-insensitive and does not issue Confluence requests', () => {
  const a=app(); const node=popupDocument(a);
  a.run(`state.query='  EASTER EGG  '; render()`);
  const egg=node('commentList').children[0];
  assert.equal(egg.className,'search-easter-egg');
  assert.equal(egg.children[0].src,'https://i.gifer.com/ZC9P.gif');
  assert.equal(egg.children[0].referrerPolicy,'no-referrer');
  assert.equal(a.calls.length,0);
  a.run(`state.query=''; render()`);
  assert.equal(node('commentList').children[0].className,'empty');
});
test('tab labels count matching entries independently of the active tab', () => {
  const a=app(); popupDocument(a);
  const tabs=['mine','watched','done'].map(filter=>({dataset:{filter}}));
  a.set('tabs',tabs);
  a.run(`document.querySelectorAll=selector=>selector==='.filter-tab'?tabs:[];
    state.comments=[
      ...buildThreads([{id:'1',pageTitle:'Match',version:{authorId:'me'},body:{}},{id:'2',pageTitle:'Match',version:{authorId:'other'},body:{}},{id:'3',parentCommentId:'2',version:{authorId:'me'},body:{}}],'inline'),
      ...buildThreads([{id:'4',pageTitle:'Other',resolutionStatus:'resolved',version:{authorId:'me'},body:{}}],'footer')
    ]; render();`);
  assert.deepEqual(tabs.map(tab=>tab.textContent),['Meine Kommentare (1)','Beteiligt (1)','Erledigt (1)']);
  a.run(`state.query='Match'; state.activeTab='watched'; render()`);
  assert.deepEqual(tabs.map(tab=>tab.textContent),['Meine Kommentare (1)','Beteiligt (1)','Erledigt (0)']);
  a.run(`state.query=''; state.kind='footer'; render()`);
  assert.deepEqual(tabs.map(tab=>tab.textContent),['Meine Kommentare (0)','Beteiligt (0)','Erledigt (1)']);
});

test('sync status changes do not restart the continuous indicator animation', () => {
  const a=app(); const node=popupDocument(a);
  a.run('applySyncStatus({host:state.settings.host,email:state.settings.email,state:"idle"})');
  let toggles=0;
  node('syncIndicator').classList.toggle=()=>{toggles++;};
  a.run('applySyncStatus({host:state.settings.host,email:state.settings.email,state:"syncing"})');
  assert.equal(toggles,0);
  a.run('applySyncStatus({host:state.settings.host,email:state.settings.email,state:"idle"})');
  assert.equal(toggles,0);
  const html=fs.readFileSync('popup.html','utf8');
  assert.doesNotMatch(html,/id="refreshButton"/);
  assert.match(fs.readFileSync('popup.css','utf8'),/\.sync-indicator\{animation:confluencelog-spin/);
  assert.match(html,/id="lastUpdated"><\/span><span id="syncIndicator"/);
});
