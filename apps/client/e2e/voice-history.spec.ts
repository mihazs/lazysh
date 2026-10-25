import { expect, test, type Page } from '@playwright/test';
import type { changeDictationHistory, useDictationHistory } from '../src/voiceHistory';

type Action=Parameters<typeof changeDictationHistory>[0];
type Result=Awaited<ReturnType<typeof changeDictationHistory>>;
type Hook=ReturnType<typeof useDictationHistory>;
declare global { interface Window { historyFixture:Hook; historyUnmount:()=>void; historyCapture:ReturnType<Hook['capture']>; historyRelease:()=>void; historyAddQueued:boolean; historyPending:Promise<void>; } }
async function change(page:Page,action:Action):Promise<Result>{
  return page.evaluate(async action=>{
    const path='/src/voiceHistory.ts';const module=await import(path);
    return module.changeDictationHistory(action);
  },action);
}
async function fixture(page:Page){
  await page.goto('/');
  await page.evaluate(async()=>{
    const reactPath='/node_modules/.vite/deps/react.js',domPath='/node_modules/.vite/deps/react-dom_client.js';
    const historyPath='/src/voiceHistory.ts',panelPath='/src/VoiceHistoryPanel.tsx';
    const [react,dom,history,panel]=await Promise.all([import(reactPath),import(domPath),import(historyPath),import(panelPath)]);
    document.getElementById('root')!.hidden=true;
    const container=document.createElement('div');document.body.append(container);
    const root=dom.default.createRoot(container);
    function Fixture(){
      const state=history.useDictationHistory();window.historyFixture=state;
      return react.default.createElement(panel.default,{history:state,onReuse:()=>{}});
    }
    root.render(react.default.createElement(Fixture));window.historyUnmount=()=>root.unmount();
  });
  await expect.poll(()=>page.evaluate(()=>window.historyFixture?.ready)).toBe(true);
}
const entry=(text='private prompt',createdAt=Date.now())=>({id:crypto.randomUUID(),text,createdAt});

test('two writers cannot append or re-enable from stale snapshots after clear, delete or disable',async({page,context})=>{
  await page.goto('/');const other=await context.newPage();await other.goto('/');
  for(const operation of ['clear','remove','disable'] as const){
    const initial=await change(page,{type:'read'});
    const sample=entry();
    const enabled=await change(page,{type:'remember',value:true,epoch:initial.history.epoch,entries:[sample]});
    const stale=await change(other,{type:'read'});
    expect(stale.history.epoch).toBe(enabled.history.epoch);
    // No BroadcastChannel or storage notification is delivered to the stale writer before it completes.
    if(operation==='disable')await change(page,{type:'remember',value:false,epoch:enabled.history.epoch,entries:[]});
    else await change(page,{type:operation,id:sample.id});
    expect((await change(other,{type:'add',epoch:stale.history.epoch,entry:entry('late capture')})).accepted).toBe(false);
    expect((await change(other,{type:'remember',value:true,epoch:stale.history.epoch,entries:stale.history.entries})).accepted).toBe(false);
    const final=await change(page,{type:'read'});
    expect(final.history.entries).toEqual([]);expect(final.history.remember).toBe(operation!=='disable');
  }
});

test('simultaneous persistent appends merge rather than overwrite another writer',async({page,context})=>{
  await page.goto('/');const other=await context.newPage();await other.goto('/');
  const enabled=await change(page,{type:'remember',value:true,epoch:'',entries:[]});
  const [first,second]=[entry('first'),entry('second')];
  await Promise.all([change(page,{type:'add',epoch:enabled.history.epoch,entry:first}),change(other,{type:'add',epoch:enabled.history.epoch,entry:second})]);
  expect((await change(page,{type:'read'})).history.entries.map(item=>item.text).sort()).toEqual(['first','second']);
});

test('default is ephemeral; explicit opt-in persists, delete and clear work, disabling removes saved text',async({page})=>{
  await fixture(page);
  await page.evaluate(async()=>{await window.historyFixture.add('temporary text',window.historyFixture.capture());});
  expect((await change(page,{type:'read'})).history.entries).toEqual([]);
  await page.getByLabel('Remember dictation history on this device').click();
  await expect.poll(async()=>(await change(page,{type:'read'})).history.entries.length).toBe(1);
  await fixture(page);
  await page.getByText('Recent dictation (1)',{exact:true}).click();
  await expect(page.getByRole('button',{name:'Delete dictation 1'})).toHaveCount(1);
  await page.getByRole('button',{name:'Delete dictation 1'}).click();
  await expect.poll(async()=>(await change(page,{type:'read'})).history.entries.length).toBe(0);
  await page.evaluate(async()=>{await window.historyFixture.add('next result',window.historyFixture.capture());});
  await page.getByRole('button',{name:'Clear history'}).click();
  await expect.poll(async()=>(await change(page,{type:'read'})).history.entries.length).toBe(0);
  await page.evaluate(async()=>{await window.historyFixture.add('forget me',window.historyFixture.capture());});
  await page.getByLabel('Remember dictation history on this device').click();
  await expect.poll(async()=>(await change(page,{type:'read'})).history).toMatchObject({remember:false,entries:[]});
  await fixture(page);expect(await page.evaluate(()=>window.historyFixture.entries)).toEqual([]);
});

for(const retry of ['delete','clear'] as const){
  test(`failed disable removal can be retried with ${retry} without reviving a pending capture`,async({page})=>{
    await fixture(page);
    await page.getByLabel('Remember dictation history on this device').click();
    await expect.poll(()=>page.evaluate(()=>window.historyFixture.remember && !window.historyFixture.pending)).toBe(true);
    await page.evaluate(async()=>{
      await window.historyFixture.add('saved private text',window.historyFixture.capture());
      window.historyCapture=window.historyFixture.capture();
      const original=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(...args:Parameters<IDBDatabase['transaction']>){
        IDBDatabase.prototype.transaction=original;throw new Error('Injected device storage failure');
      };
    });
    await page.getByLabel('Remember dictation history on this device').click();
    await expect(page.getByRole('alert')).toContainText('could not be deleted');
    expect((await change(page,{type:'read'})).history.entries[0].text).toBe('saved private text');
    await page.evaluate(async()=>{await window.historyFixture.add('late text',window.historyCapture);});
    if(retry==='delete')await page.getByText('Recent dictation (1)',{exact:true}).click();
    await page.getByRole('button',{name:retry==='delete'?'Delete dictation 1':'Clear history'}).click();
    await expect.poll(async()=>(await change(page,{type:'read'})).history).toMatchObject({remember:false,entries:[]});
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('unmount and local clear invalidate pending captures while fresh captures still work',async({page})=>{
  await fixture(page);
  await page.getByLabel('Remember dictation history on this device').click();
  await expect.poll(()=>page.evaluate(()=>window.historyFixture.remember && !window.historyFixture.pending)).toBe(true);
  await page.evaluate(async()=>{await window.historyFixture.add('old text',window.historyFixture.capture());window.historyCapture=window.historyFixture.capture();});
  await page.getByRole('button',{name:'Clear history'}).click();
  await expect.poll(()=>page.evaluate(()=>window.historyFixture.pending)).toBe(false);
  await page.evaluate(async()=>{await window.historyFixture.add('late cleared text',window.historyCapture);});
  expect((await change(page,{type:'read'})).history.entries).toEqual([]);
  await page.evaluate(async()=>{window.historyCapture=window.historyFixture.capture();window.historyUnmount();await window.historyFixture.add('late unmounted text',window.historyCapture);});
  expect((await change(page,{type:'read'})).history.entries).toEqual([]);
});

test('expired saved entries are pruned on opening and original recording times stay unchanged',async({page})=>{
  await page.goto('/');const fresh=entry('fresh'),old=entry('expired',Date.now()-7*24*60*60*1000-1000);
  const enabled=await change(page,{type:'remember',value:true,epoch:'',entries:[fresh]});
  await page.evaluate(async({enabled,old})=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('lazysh-voice-history-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise<void>((resolve,reject)=>{const transaction=db.transaction('history','readwrite');transaction.objectStore('history').put({...enabled.history,entries:[old,...enabled.history.entries]},'state');transaction.oncomplete=()=>resolve();transaction.onabort=()=>reject(transaction.error);});db.close();
  },{enabled,old});
  await fixture(page);
  expect((await change(page,{type:'read'})).history.entries).toEqual([fresh]);
});

for(const operation of ['add','remember'] as const){
test(`view cancellation rejects queued captures but preserves an explicit ${operation==='remember'?'Remember commit':'existing consent'}`,async({page})=>{
  await fixture(page);
  if(operation==='add'){
    await page.getByLabel('Remember dictation history on this device').click();
    await expect.poll(()=>page.evaluate(()=>window.historyFixture.remember && !window.historyFixture.pending)).toBe(true);
  }
  await page.evaluate(async operation=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('lazysh-voice-history-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    let held=true;window.historyRelease=()=>{held=false;};
    const transaction=db.transaction('history','readwrite'),store=transaction.objectStore('history');
    const hold=()=>{const request=store.get('state');request.onsuccess=()=>{if(held)hold();};};hold();
    transaction.oncomplete=()=>db.close();
    const original=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args:Parameters<IDBDatabase['transaction']>){
      IDBDatabase.prototype.transaction=original;window.historyAddQueued=true;return original.apply(this,args);
    };
    window.historyPending=operation==='add'?window.historyFixture.add('cancelled queued text',window.historyFixture.capture()):window.historyFixture.setRemember(true);
  },operation);
  await expect.poll(()=>page.evaluate(()=>window.historyAddQueued)).toBe(true);
  await page.evaluate(async()=>{window.historyFixture.invalidate();window.historyRelease();await window.historyPending;});
  expect((await change(page,{type:'read'})).history.entries).toEqual([]);
  await expect.poll(()=>page.evaluate(()=>window.historyFixture.remember)).toBe(true);
});
}
