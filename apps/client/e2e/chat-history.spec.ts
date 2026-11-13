import {expect,test,type Page} from '@playwright/test';
import {openFollowTranscript} from './fixtures/chatTranscript';

const TOTAL=12_000,PAGE=50;
declare global {interface Window {historyFixture:{windows:unknown[];fail:number;hold?:Promise<void>;release?:()=>void}}}

/** A synthetic companion that serves a 12k message Claude session in windows, as `transcript --view conversation` does. */
/** `hold` keeps the pages the reader asked for until `release`; `fail` makes that many of them fail. */
async function open(page:Page,{total=TOTAL,hold=false,fail=0}={}) {
  await page.goto('/');
  await page.evaluate(async ({total,size,hold,fail})=>{
    window.historyFixture={windows:[],fail};
    if(hold)window.historyFixture.hold=new Promise<void>(resolve=>{window.historyFixture.release=resolve;});
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:{window?:{before?:string;after?:string;fromStart?:boolean}})=>{
      if(command!=='agent_transcript')throw new Error('Unexpected fixture command');
      window.historyFixture.windows.push(args.window??null);
      if(args.window && window.historyFixture.fail>0){window.historyFixture.fail--;throw new Error('connection reset');}
      if(args.window)await window.historyFixture.hold;
      const index=(id:string)=>Number(id.slice(1)),w=args.window??{};
      const from=w.fromStart?0:w.before?Math.max(0,index(w.before)-size):w.after?index(w.after)+1:total-size;
      const to=w.before?index(w.before):Math.min(total,from+size);
      return {schemaVersion:1,agent:'claude',view:'active_branch',hasMore:false,nextOffset:0,branchId:'leaf',truncated:from>0,...(to<total?{hasNewer:true}:{hasNewer:false}),
        messages:Array.from({length:to-from},(_,offset)=>({id:`m${from+offset}`,role:(from+offset)%2?'assistant':'user',blocks:[{type:'text',text:`Message ${from+offset}: a synthetic line long enough to wrap on a phone screen and give the rows a real height.`}]}))};
    }}});
  },{total,size:PAGE,hold,fail});
  await openFollowTranscript(page,'claude');
  await expect(page.getByText(`Message ${total-1}:`,{exact:false})).toBeVisible();
}
const list=(page:Page)=>page.getByRole('region',{name:'Conversation messages'});
const top=(page:Page,text:string)=>page.getByText(text,{exact:false}).evaluate((node,)=>{
  const box=node.getBoundingClientRect(),area=node.closest('.chat-messages')!.getBoundingClientRect();return box.top-area.top;
});

const edge=(page:Page,name:'top'|'bottom')=>page.locator(`.chat-history-edge[data-edge="${name}"]`);
/** The message at the top of the reading area and how far below its top edge it sits. */
const reading=(page:Page)=>list(page).evaluate(area=>{
  const box=area.getBoundingClientRect(),article=[...area.querySelectorAll('article')].find(node=>node.getBoundingClientRect().bottom>box.top)!;
  return {id:(article as HTMLElement).dataset.anchor!,offset:article.getBoundingClientRect().top-box.top};
});
const offsetOf=(page:Page,id:string)=>list(page).evaluate((area,anchor)=>area.querySelector(`article[data-anchor="${anchor}"]`)!.getBoundingClientRect().top-area.getBoundingClientRect().top,id);
/** Scrolls to an end of the list again and again, never tapping, until the marker for that end shows. */
async function scrollUntil(page:Page,to:'top'|'bottom',marker:string,peak:{rows:number}) {
  const requests=()=>page.evaluate(()=>window.historyFixture.windows.length);
  for(let seen=await requests();!await page.getByText(marker).isVisible();) {
    await list(page).evaluate((area,end)=>{area.scrollTop=end==='top'?0:area.scrollHeight;},to);
    peak.rows=Math.max(peak.rows,await page.locator('.chat-messages article').count());
    // The next page is on its way or the marker is: either way something changes within the budget.
    await expect.poll(async()=>(await requests())>seen || await page.getByText(marker).isVisible(),{timeout:10_000,intervals:[20]}).toBe(true);
    seen=await requests();
  }
}

test('scrolling up reads earlier pages without a tap and without moving the line being read',async({page})=>{
  await open(page,{hold:true});
  await expect(page.getByText('Start of the session')).toHaveCount(0);
  // The list is at its top, so the page above is already being read: a spinner on that edge, nothing else moves.
  await expect(edge(page,'top').locator('.chat-history-spinner')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.historyFixture.windows)).toEqual([null,{before:'m11950'}]);
  await list(page).evaluate(area=>{area.scrollTop=300;});
  const read=await reading(page);
  await page.evaluate(()=>window.historyFixture.release!());
  await expect(page.getByText('Message 11949:',{exact:false})).toBeAttached();
  // The reader was looking at that line; it is where it was (to the pixel) after the page above it arrived.
  expect(Math.abs(await offsetOf(page,read.id)-read.offset)).toBeLessThan(1);
  await expect(edge(page,'top').locator('.chat-history-spinner')).toHaveCount(0);
  // The load buttons are not part of the layout while scrolling does the work, but a screen reader can still reach them.
  expect((await edge(page,'top').locator('.chat-history-fallback').boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button',{name:'Load earlier messages'})).toBeAttached();
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

test('scrolling to the top reads on to the first message and back down to the end, one page at a time, within the window',async({page})=>{
  test.setTimeout(240_000);
  await open(page,{total:10_000});
  const peak={rows:0};
  await scrollUntil(page,'top','Start of the session',peak);
  await expect(page.getByText('Message 0:',{exact:false})).toBeAttached();
  const windows=(await page.evaluate(()=>window.historyFixture.windows)) as ({before:string}|null)[];
  // Each page continued from the first message the window held: no gap, no repeat, none requested twice.
  expect(windows.slice(1).map(window=>window!.before)).toEqual(windows.slice(1).map((_,index)=>`m${9950-index*PAGE}`));
  expect(peak.rows).toBeLessThanOrEqual(400);
  // The newest messages were released on the way up. Scrolling down reads them back, again without a tap.
  expect(await page.getByText('Message 9999:',{exact:false}).count()).toBe(0);
  await scrollUntil(page,'bottom','End of the session so far',peak);
  await expect(page.getByText('Message 9999:',{exact:false})).toBeAttached();
  expect(peak.rows).toBeLessThanOrEqual(400);
  expect(((await page.evaluate(()=>window.historyFixture.windows)) as {after?:string}[]).filter(window=>window?.after).length).toBeGreaterThan(0);
});

test('a failed page stops with a Retry row, a spinner shows while it is read again, and a reduced-motion spinner does not turn',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await open(page,{fail:1});
  await expect(page.getByRole('alert')).toContainText('connection reset');
  // No silent retry loop: the one failed request is the only one.
  await page.waitForTimeout(400);
  expect(await page.evaluate(()=>window.historyFixture.windows)).toEqual([null,{before:'m11950'}]);
  await page.evaluate(()=>{window.historyFixture.hold=new Promise<void>(resolve=>{window.historyFixture.release=resolve;});});
  await page.getByRole('button',{name:'Retry'}).click();
  await expect(edge(page,'top').locator('.chat-history-spinner')).toBeVisible();
  expect(await edge(page,'top').locator('.chat-history-spinner').evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
  await page.evaluate(()=>window.historyFixture.release!());
  await expect(page.getByText('Message 11949:',{exact:false})).toBeAttached();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('without IntersectionObserver the buttons stay visible and read the pages',async({page})=>{
  await page.addInitScript(()=>{delete (window as Partial<typeof globalThis>).IntersectionObserver;});
  await open(page);
  const button=page.getByRole('button',{name:'Load earlier messages'});
  await expect(button).toBeVisible();
  expect((await button.boundingBox())!.width).toBeGreaterThan(40);
  await list(page).evaluate(e=>{e.scrollTop=0;});
  await page.waitForTimeout(300);
  expect(await page.evaluate(()=>window.historyFixture.windows)).toEqual([null]);
  await button.click();
  await expect(page.getByText('Message 11949:',{exact:false})).toBeAttached();
});
