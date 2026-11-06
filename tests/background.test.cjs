const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const settings = {host:'https://example.atlassian.net', email:'me@example.com', token:'secret'};
const root = (version = 2, resolutionStatus = 'open') => ({id:'1',pageId:'9',resolutionStatus,version:{number:version,authorId:'me',createdAt:'2026-01-01'},body:{atlas_doc_format:{value:JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Hello'}]}]})}}});
function worker(initial = {settings}, route = () => undefined, popupOpen = true) {
  const data = structuredClone(initial), calls = [], alarms = new Map(), timers = new Map();
  let timerId = 0;
  const event = () => ({ listeners:[], addListener(callback) {this.listeners.push(callback);} });
  const changed = event();
  const store = {
    async get(keys) {return structuredClone(Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(key => key in data).map(key => [key,data[key]])));},
    async set(values) {
      const changes = {};
      for (const [key,value] of Object.entries(values)) {changes[key]={oldValue:data[key],newValue:value};data[key]=structuredClone(value);}
      changed.listeners.forEach(callback => callback(changes,'local'));
    },
    async remove(keys) {for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];}
  };
  const chrome = {storage:{local:store,onChanged:changed}, permissions:{contains:async () => true},
    alarms:{get:async name => alarms.get(name), create:async (name, options) => alarms.set(name, options),clear:async name => alarms.delete(name),onAlarm:event()},
    runtime:{getContexts:async () => popupOpen ? [{documentUrl:'chrome-extension://test/popup.html'}] : [],onConnect:event(),id:'test',getURL:path => `chrome-extension://test/${path}`,onMessage:event(),onStartup:event(),onInstalled:event()}
  };
  let context;
  context = vm.createContext({chrome,URL,Intl,AbortSignal,console,btoa,
    setTimeout:(callback,delay) => {const id=++timerId;timers.set(id,{callback,delay});return id;}, clearTimeout:id => timers.delete(id),
    importScripts: path => vm.runInContext(fs.readFileSync(path,'utf8'),context),
    fetch:async (url, options) => {
      calls.push({url,options});
      let result = await route(new URL(url), options);
      if (!result) {
        const path = new URL(url).pathname;
        if (path === '/wiki/rest/api/user/current') result={data:{accountId:'me',displayName:'Me'}};
        else if (path === '/wiki/api/v2/inline-comments') result={data:{results:[root()]}};
        else if (path === '/wiki/api/v2/footer-comments') result={data:{results:[]}};
        else if (path === '/wiki/api/v2/tasks') result={data:{results:[]}};
        else if (path === '/wiki/api/v2/inline-comments/1' && options.method === 'PUT') result={data:root(3,'resolved')};
        else if (path === '/wiki/api/v2/inline-comments/1') result={data:root(new URL(url).searchParams.has('version')?1:2)};
        else if (path === '/wiki/api/v2/pages/9') result={data:{id:'9',title:'Page'}};
        else if (path === '/wiki/rest/api/user') result={data:{accountId:'me',displayName:'Me'}};
        else throw new Error('Unexpected API path: '+url);
      }
      return {ok:!(result.status >= 400),status:result.status ?? 200,headers:{get:name=>result.headers?.[name]??null},json:async () => result.data ?? {}};
    }
  });
  vm.runInContext(fs.readFileSync('background.js','utf8'),context);
  let connectedPort;
  async function openPopup() {
    popupOpen = true;
    connectedPort = {name:'confluence-popup',sender:{id:'test',url:'chrome-extension://test/popup.html'},onDisconnect:event()};
    await Promise.all(chrome.runtime.onConnect.listeners.map(callback=>callback(connectedPort)));
  }
  function closePopup() {
    popupOpen = false;
    connectedPort?.onDisconnect.listeners.forEach(callback=>callback());
  }
  return {data,calls,alarms,chrome,timers,openPopup,closePopup,run:code => vm.runInContext(code,context),
    send:message => new Promise(resolve => chrome.runtime.onMessage.listeners[0]({type:'confluence',...message},{id:'test',url:'chrome-extension://test/popup.html'},resolve))};
}
test('background creates a recovery alarm and persists credential-free data across restarts', async () => {
  const a = worker();
  const response = await a.send({action:'refresh',force:true});
  assert.equal(response.ok,true); assert.equal(a.alarms.get('confluence-refresh').periodInMinutes,0.5);
  assert.equal(a.data.commentCache.threads.length,1);
  assert.equal(a.data.commentCache.me.accountId,'me');
  assert.doesNotMatch(JSON.stringify(a.data.commentCache), /secret|Authorization|Basic /);
  const before = a.calls.length;
  await a.send({action:'refresh',force:false});
  assert.equal(a.calls.length,before);
  const restarted = worker(a.data);
  await restarted.send({action:'refresh',force:false});
  assert.equal(restarted.calls.length,0);
});
test('subsequent refresh reuses original authors and metadata, and retains resolved threads', async () => {
  let closed = false;
  const a = worker(undefined, url => url.pathname === '/wiki/api/v2/inline-comments' ? {data:{results:[root(3,closed?'resolved':'open')]}} : undefined);
  await a.send({action:'refresh',force:true});
  a.calls.length=0;
  await a.send({action:'refresh',force:true});
  assert.deepEqual(a.calls.map(call => new URL(call.url).pathname), ['/wiki/rest/api/user/current','/wiki/api/v2/inline-comments','/wiki/api/v2/footer-comments','/wiki/api/v2/tasks']);
  closed=true; a.calls.length=0;
  await a.send({action:'refresh',force:true});
  assert.equal(a.data.commentCache.threads.length,1); assert.equal(a.data.commentCache.threads[0].comments[0].resolutionStatus,'resolved'); assert.equal(a.calls.length,4);
});
test('offline refresh retains last good snapshot and records failure', async () => {
  let offline=false;
  const a = worker(undefined, () => {if (offline) throw new Error('Offline');});
  await a.send({action:'refresh',force:true});
  const cache = structuredClone(a.data.commentCache);
  offline=true;
  const response=await a.send({action:'refresh',force:true});
  assert.equal(response.ok,false); assert.equal(response.error.message,'Offline');
  assert.deepEqual(a.data.commentCache,cache); assert.equal(a.data.syncStatus.state,'error');
});
test('authorization failure invalidates cache', async () => {
  let denied=false;
  const a = worker(undefined, () => denied ? {status:401} : undefined);
  await a.send({action:'refresh',force:true}); denied=true;
  const response=await a.send({action:'refresh',force:true});
  assert.equal(response.error.status,401); assert.equal(a.data.commentCache,undefined);
});
test('background rejects reply and resolve without sending any API requests', async () => {
  const a=worker();
  for (const action of ['reply','resolve']) {
    const response=await a.send({action,host:settings.host,accountId:'me',id:'1',text:'Reply'});
    assert.equal(response.ok,false); assert.equal(response.error.message,'readOnly');
  }
  assert.equal(a.calls.length,0);
});
test('old refresh cannot overwrite data after credentials change', async () => {
  let release;
  const gate=new Promise(resolve => {release=resolve;});
  const a=worker(undefined, async url => {if (url.pathname === '/wiki/api/v2/inline-comments') await gate;});
  const request=a.send({action:'refresh',force:true});
  await new Promise(resolve => setImmediate(resolve));
  a.data.settings={...settings,host:'https://other.atlassian.net'};
  release();
  const result=await request;
  assert.equal(result.ok,false); assert.equal(a.data.commentCache,undefined);
});
test('recovery resumes a full refresh while a popup is open', async () => {
  let version=2;
  const a=worker(undefined, url => url.pathname === '/wiki/api/v2/inline-comments' ? {data:{results:[root(version)]}} : undefined);
  await a.send({action:'refresh',force:true});
  version=3;
  await a.run('resumeLoop()');
  assert.equal(a.data.commentCache.threads[0].comments[0].version.number,3);
});

test('refresh caches both open and resolved conversations of both types', async () => {
  const a=worker(undefined,url => {
    if (url.pathname === '/wiki/api/v2/footer-comments') return {data:{results:[
      {...root(1),id:'10'}, {...root(1,'resolved'),id:'11'}
    ]}};
  });
  const response=await a.send({action:'refresh',force:true});
  assert.equal(response.ok,true);
  assert.deepEqual(a.data.commentCache.threads.map(item=>item.kind).sort(),['footer','footer','inline']);
  assert.ok(a.calls.every(call => !call.options.method || call.options.method === 'GET'));
});
test('a failed comment type retains its previous snapshot and reports incomplete results', async () => {
  let fail=false;
  const a=worker(undefined,url=>url.pathname==='/wiki/api/v2/footer-comments'?fail?{status:500}:{data:{results:[{...root(1),id:'10'}]}}:undefined);
  await a.send({action:'refresh',force:true}); fail=true;
  const response=await a.send({action:'refresh',force:true});
  assert.equal(response.ok,true);
  assert.equal(a.data.commentCache.threads.filter(thread=>thread.kind==='footer').length,1);
  assert.match(a.data.commentCache.warnings.join(),/HTTP 500/);
});

test('successful passes schedule the next full refresh immediately without overlapping', async () => {
  const a=worker();
  await a.send({action:'refresh',force:true});
  assert.equal(a.timers.size,1);
  const timer=[...a.timers.values()][0]; assert.equal(timer.delay,0);
  const count=a.calls.length;
  await timer.callback();
  assert.ok(a.calls.length>count); assert.equal(a.timers.size,1);
  assert.equal(a.data.syncControl.failures,0);
});
test('rate limiting persists Retry-After and prevents early retries after worker restart', async () => {
  const a=worker(undefined,()=>({status:429,headers:{'Retry-After':'120'}}));
  const response=await a.send({action:'refresh',force:true});
  assert.equal(response.ok,false);
  assert.ok(a.data.syncControl.nextAllowedAt-Date.now()>119000);
  const count=a.calls.length;
  await a.send({action:'refresh',force:true});
  assert.equal(a.calls.length,count);
  const restarted=worker(a.data);
  await restarted.run('resumeLoop()');
  assert.equal(restarted.calls.length,0);
});
test('offline failures back off and authentication failures stop automatic retries', async () => {
  const offline=worker(undefined,()=>{throw new Error('Offline');});
  await offline.send({action:'refresh',force:true});
  assert.ok([...offline.timers.values()][0].delay>=30000);
  offline.data.syncControl.nextAllowedAt=0;
  await offline.send({action:'refresh',force:true});
  assert.ok([...offline.timers.values()][0].delay>=60000);
  const denied=worker(undefined,()=>({status:401}));
  await denied.send({action:'refresh',force:true});
  assert.equal(denied.data.syncControl.blocked,true);
  const count=denied.calls.length;
  await denied.run('resumeLoop()');
  assert.equal(denied.calls.length,count);
});

test('closing the popup finishes the current sync but starts no further pass', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const a=worker(undefined,async url=>{if(url.pathname==='/wiki/api/v2/inline-comments')await gate;});
  await a.openPopup();
  const request=a.send({action:'refresh',force:true});
  await new Promise(resolve=>setImmediate(resolve));
  a.closePopup();
  release();
  const result=await request;
  assert.equal(result.ok,true); assert.equal(a.data.commentCache.threads.length,1);
  assert.equal(a.timers.size,0); assert.equal(a.alarms.size,0);
  const count=a.calls.length;
  await a.run('resumeLoop()');
  assert.equal(a.calls.length,count);
});
test('reopening starts immediately and joins a still-running sync', async () => {
  let release, blocking=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const a=worker(undefined,async url=>{if(blocking&&url.pathname==='/wiki/api/v2/inline-comments')await gate;});
  await a.openPopup(); await a.send({action:'refresh',force:true});
  a.closePopup(); const count=a.calls.length;
  await a.openPopup();
  const timer=[...a.timers.values()][0]; assert.equal(timer.delay,0);
  blocking=true;
  const running=timer.callback();
  await new Promise(resolve=>setImmediate(resolve));
  a.closePopup(); await a.openPopup();
  const joined=a.send({action:'refresh',force:true});
  release(); await Promise.all([running,joined]);
  assert.equal(a.calls.filter(call=>call.url.endsWith('/user/current')).length,2);
  assert.ok(a.calls.length>count);
});
test('worker restart with no popup creates no loop and makes no API requests', async () => {
  const a=worker(undefined,undefined,false);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.timers.size,0); assert.equal(a.alarms.size,0);
  await a.run('resumeLoop()'); assert.equal(a.calls.length,0);
  await a.openPopup();
  assert.equal([...a.timers.values()][0].delay,0);
});
test('task synchronization shares the cache and retains last successful tasks on API failure', async () => {
  let failed=false, completed=false;
  const a=worker(undefined,url=>url.pathname==='/wiki/api/v2/tasks'? failed?{status:403}:{data:{results:completed?[]:[{id:'task1',status:'incomplete',assignedTo:'me',dueAt:'2026-11-06T00:00:00Z',body:root().body}]}}:undefined);
  await a.send({action:'refresh',force:true});
  assert.equal(a.data.commentCache.tasks.length,1);
  const lastUpdated=a.data.commentCache.tasksUpdatedAt;
  failed=true;
  const response=await a.send({action:'refresh',force:true});
  assert.equal(response.ok,true); assert.equal(a.data.commentCache.tasks.length,1);
  assert.equal(a.data.commentCache.tasksUpdatedAt,lastUpdated);
  assert.equal(a.data.commentCache.tasksError.status,403);
  assert.equal(a.data.commentCache.threads.length,1);
  failed=false;completed=true;a.data.syncControl.nextAllowedAt=0;
  await a.send({action:'refresh',force:true});
  assert.equal(a.data.commentCache.tasks.length,0);assert.equal(a.data.commentCache.tasksError,null);
});
test('tasks can synchronize when both comment collections are unavailable', async () => {
  const a=worker(undefined,url=>{
    if(url.pathname.endsWith('-comments')) return {status:500};
    if(url.pathname==='/wiki/api/v2/tasks') return {data:{results:[{id:'1',status:'incomplete',assignedTo:'me',body:root().body}]}};
  });
  const response=await a.send({action:'refresh',force:true});
  assert.equal(response.ok,true);assert.equal(a.data.commentCache.tasks.length,1);
  assert.equal(a.data.commentCache.threads.length,0);assert.equal(a.data.commentCache.incomplete,true);
});
