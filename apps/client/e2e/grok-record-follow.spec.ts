import {expect,test,type Page} from '@playwright/test';
import {openFollowTranscript} from './fixtures/chatTranscript';
declare global {interface Window {
  grokRecordFixture: {calls:Record<string,unknown>[];hold:boolean;release?:()=>void;failure:string;append:boolean;drafts:number};
}}
async function setup(page:Page) {
  await page.goto('/');
  await page.evaluate(async()=>{
    const {grokFollowPage}=await import('/src/test/recordedFollowData.ts');
    window.grokRecordFixture={calls:[],hold:false,failure:'',append:false,drafts:0};
    window.addEventListener('lazysh-prompt-draft',()=>{window.grokRecordFixture.drafts++;});
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>)=>{
      if(command!=='agent_transcript')throw new Error('Unexpected recorded-file command');
      const f=window.grokRecordFixture;f.calls.push(args);
      if(f.failure)throw new Error(f.failure);
      const start=args.offset===0,verified=args.checkpointed===true;
      const offset=Number(args.offset),next=start ? 40 : offset+(f.append?40:0);
      const text=verified ? (start?'Verified':'Appended') : 'Legacy';
      const prefix=start?'a':f.append?'c':String(args.checkpoint).split(':')[4]?.[0]??'a';
      const result={...grokFollowPage(next,next,'',prefix),checkpoint:verified?grokFollowPage(next,next,'',prefix).checkpoint:undefined,
        messages:start||f.append?Array.from({length:40},(_,i)=>({id:`grok-record-${next-40+i}`,role:'assistant',blocks:[{type:'text',text:`${text} row ${next-40+i}: synthetic file record for scrolling.`}]})):[]};
      f.append=false;
      if(f.hold)return new Promise(resolve=>{f.release=()=>resolve(result);});
      return result;
    }}});
  });
  await openFollowTranscript(page,'grok-acp');
  await expect(page.getByText('Legacy row 0:',{exact:false})).toBeVisible();
  await page.clock.install();
}
const start=(page:Page)=>page.getByRole('button',{name:'Start following recorded file',exact:true}).click();
const count=(page:Page)=>page.evaluate(()=>window.grokRecordFixture.calls.length);

test('verified preparation replaces legacy pages; paused manual reads retain the original file and reader position',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{window.grokRecordFixture.hold=true;});
  await start(page);
  await expect(page.getByText('Legacy row 0:',{exact:false})).toBeVisible();
  await page.evaluate(()=>{window.grokRecordFixture.hold=false;window.grokRecordFixture.release?.();});
  const follow=page.getByLabel('Follow recorded file',{exact:true});
  await expect(follow).toBeChecked();await expect(page.getByText('Legacy row 0:',{exact:false})).toHaveCount(0);
  const messages=page.getByRole('region',{name:'Recorded file messages'});
  await expect.poll(()=>messages.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeLessThanOrEqual(24);
  await messages.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
  await page.evaluate(()=>{window.grokRecordFixture.append=true;});
  await page.clock.runFor(2000);
  await expect(page.getByText('Appended row 79:',{exact:false})).toHaveCount(1);
  expect(await messages.evaluate(e=>e.scrollTop)).toBe(0);
  await page.getByRole('button',{name:'Jump to latest'}).click();
  await expect.poll(()=>messages.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeLessThanOrEqual(24);
  await follow.uncheck();await page.getByRole('button',{name:'Refresh new messages'}).click();
  await expect(follow).not.toBeChecked();
  await page.clock.runFor(10000);expect(await count(page)).toBe(4);
  const calls=await page.evaluate(()=>window.grokRecordFixture.calls);
  expect(calls[0]).not.toHaveProperty('checkpointed');
  expect(calls.slice(1).every(c=>c.checkpointed===true&&c.sessionId==='fixture-host'&&c.path==='/fixture/updates.jsonl')).toBe(true);
  expect(calls[3].offset).toBe(80);expect(calls[3].checkpoint).toMatch(/^g1:/);
  expect(await page.evaluate(()=>window.grokRecordFixture.drafts)).toBe(0);
});

test('old companion errors preserve manual records with no scheduled legacy fallback',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{window.grokRecordFixture.failure='Synthetic unknown option --checkpointed';});
  await start(page);
  await expect(page.getByRole('alert')).toHaveText('Synthetic unknown option --checkpointed');
  await expect(page.getByText('Legacy row 0:',{exact:false})).toBeVisible();
  await expect(page.getByLabel('Follow recorded file',{exact:true})).toHaveCount(0);
  await page.clock.runFor(20000);expect(await count(page)).toBe(2);
});

test('held automatic output stays discarded after hide/show and later access revocation',async({page})=>{
  await setup(page);await start(page);
  await page.evaluate(()=>{window.grokRecordFixture.hold=true;window.grokRecordFixture.append=true;});
  await page.clock.runFor(2000);await page.clock.runFor(20000);expect(await count(page)).toBe(3);
  await page.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pageshow'));window.grokRecordFixture.release?.();});
  await expect(page.getByText('Appended row 79:',{exact:false})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Refresh new messages'})).toBeEnabled();
  await page.evaluate(()=>{window.grokRecordFixture.append=true;});
  await page.clock.runFor(2000);expect(await count(page)).toBe(4);
  const calls=await page.evaluate(()=>window.grokRecordFixture.calls);
  expect(calls[3]).toEqual(calls[2]);
  await page.evaluate(()=>{window.chatFollow.revoke();window.grokRecordFixture.release?.();});
  await expect(page.getByLabel('Follow recorded file',{exact:true})).not.toBeChecked();
  await expect(page.getByLabel('Follow recorded file',{exact:true})).toBeDisabled();
  await expect(page.getByText('Appended row 79:',{exact:false})).toHaveCount(0);
  await page.clock.runFor(20000);expect(await count(page)).toBe(4);
});
