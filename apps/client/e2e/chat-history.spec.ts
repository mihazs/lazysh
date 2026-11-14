import {expect,test,type Page} from '@playwright/test';
import {openFollowTranscript} from './fixtures/chatTranscript';

const TOTAL=12_000,PAGE=50;
declare global {interface Window {historyFixture:{windows:unknown[]}}}

/** A synthetic companion that serves a 12k message Claude session in windows, as `transcript --view conversation` does. */
async function open(page:Page) {
  await page.goto('/');
  await page.evaluate(async ({total,size})=>{
    window.historyFixture={windows:[]};
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:{window?:{before?:string;after?:string;fromStart?:boolean}})=>{
      if(command!=='agent_transcript')throw new Error('Unexpected fixture command');
      window.historyFixture.windows.push(args.window??null);
      const index=(id:string)=>Number(id.slice(1)),w=args.window??{};
      const from=w.fromStart?0:w.before?Math.max(0,index(w.before)-size):w.after?index(w.after)+1:total-size;
      const to=w.before?index(w.before):Math.min(total,from+size);
      return {schemaVersion:1,agent:'claude',view:'active_branch',hasMore:false,nextOffset:0,branchId:'leaf',truncated:from>0,...(to<total?{hasNewer:true}:{hasNewer:false}),
        messages:Array.from({length:to-from},(_,offset)=>({id:`m${from+offset}`,role:(from+offset)%2?'assistant':'user',blocks:[{type:'text',text:`Message ${from+offset}: a synthetic line long enough to wrap on a phone screen and give the rows a real height.`}]}))};
    }}});
  },{total:TOTAL,size:PAGE});
  await openFollowTranscript(page,'claude');
  await expect(page.getByText('Message 11999:',{exact:false})).toBeVisible();
}
const list=(page:Page)=>page.getByRole('region',{name:'Conversation messages'});
const top=(page:Page,text:string)=>page.getByText(text,{exact:false}).evaluate((node,)=>{
  const box=node.getBoundingClientRect(),area=node.closest('.chat-messages')!.getBoundingClientRect();return box.top-area.top;
});

test('scrolling up reads earlier pages without moving the line being read, and Jump to start reaches the first message',async({page})=>{
  await open(page);
  await expect(page.getByText('Start of the session')).toHaveCount(0);
  await list(page).evaluate(e=>{e.scrollTop=0;});
  const before=await top(page,'Message 11950:');
  await list(page).evaluate(e=>e.dispatchEvent(new Event('scroll')));
  await expect(page.getByText('Message 11949:',{exact:false})).toBeAttached();
  // The reader was looking at "Message 11950"; it has not moved after the page above it arrived.
  await expect.poll(()=>top(page,'Message 11950:')).toBeCloseTo(before,0);
  expect(await page.evaluate(()=>window.historyFixture.windows)).toEqual([null,{before:'m11950'}]);
  await page.getByRole('button',{name:'Jump to start'}).click();
  await expect(page.getByText('Message 0:',{exact:false})).toBeVisible();
  await expect(page.getByText('Start of the session')).toBeVisible();
  expect(await list(page).evaluate(e=>e.scrollTop)).toBe(0);
  // The window is a bounded slice of 12k messages, not the session.
  expect(await page.locator('.chat-messages article').count()).toBeLessThanOrEqual(400);
  await page.getByRole('button',{name:'Jump to latest'}).click();
  await expect(page.getByText('Message 11999:',{exact:false})).toBeVisible();
  await expect.poll(()=>list(page).evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeLessThanOrEqual(24);
});
