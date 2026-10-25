import {expect,test,type Page} from '@playwright/test';
import type {mountChatFollowHarness} from './fixtures/ChatFollowHarness';
declare global {interface Window {
  chatFollow:ReturnType<typeof mountChatFollowHarness>;
  followFixture:{calls:{args:Record<string,unknown>;options:unknown}[];revision:number;hold:boolean;release?:()=>void;fail:boolean};
}}
async function fixture(page:Page) {
  await page.goto('/');
  await page.evaluate(async()=>{
    window.followFixture={calls:[],revision:1,hold:false,fail:false};
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>,options:unknown)=>{
      if(command!=='agent_transcript')throw new Error('Unexpected fixture command');
      const f=window.followFixture;f.calls.push({args,options});
      const result={schemaVersion:1,agent:'claude',view:'active_branch',hasMore:false,nextOffset:100,
        messages:Array.from({length:40},(_,i)=>({id:`${f.revision}-${i}`,role:'assistant',blocks:[{type:'text',text:`Branch ${f.revision} row ${i}: bounded synthetic message for reader position checks.`}]}))};
      if(f.fail)throw new Error('Synthetic transcript failure');
      if(f.hold)return new Promise(resolve=>{f.release=()=>resolve(result);});
      return result;
    }}});
    const {mountChatFollowHarness}=await import('/e2e/fixtures/ChatFollowHarness.tsx');window.chatFollow=mountChatFollowHarness();
  });
  await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/claude.jsonl');
  await page.getByRole('combobox',{name:'View',exact:true}).selectOption('conversation');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect(page.getByText('Branch 1 row 0:',{exact:false})).toBeVisible();
  await page.clock.install();
}
const calls=(page:Page)=>page.evaluate(()=>window.followFixture.calls.length);

test('actual scroll region preserves history and follows newest only after Jump to latest',async({page})=>{
  await fixture(page);
  const follow=page.getByLabel('Follow selected Claude branch');
  const messages=page.getByRole('region',{name:'Conversation messages'});
  await expect(follow).not.toBeChecked();
  await page.clock.runFor(10_000);expect(await calls(page)).toBe(1);
  await follow.check();
  await expect.poll(()=>messages.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeLessThanOrEqual(24);
  await messages.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
  await expect(page.getByRole('button',{name:'Jump to latest'})).toBeVisible();
  await page.evaluate(()=>{window.followFixture.revision=2;});
  await page.clock.runFor(2000);
  await expect(page.getByText('Branch 2 row 0:',{exact:false})).toBeVisible();
  await expect(page.getByText('Branch 1 row 0:',{exact:false})).toHaveCount(0);
  expect(await messages.evaluate(e=>e.scrollTop)).toBe(0);
  await page.getByRole('button',{name:'Jump to latest'}).click();
  await expect.poll(()=>messages.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeLessThanOrEqual(24);
  await page.evaluate(()=>{window.followFixture.revision=3;});
  await page.clock.runFor(2000);
  await expect(page.getByText('Branch 3 row 39:',{exact:false})).toBeVisible();
  await expect.poll(()=>messages.evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop)).toBeLessThanOrEqual(24);
  const args=await page.evaluate(()=>window.followFixture.calls.map(call=>call.args));
  expect(args.every(arg=>arg.sessionId==='fixture-host'&&arg.path==='/fixture/claude.jsonl'&&arg.view==='conversation'&&arg.offset===0)).toBe(true);
});

test('slow reads cannot overlap, and old native responses cannot appear after access revocation',async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{window.followFixture.hold=true;window.followFixture.revision=2;});
  await page.getByLabel('Follow selected Claude branch').check();
  await page.clock.runFor(2000);expect(await calls(page)).toBe(2);
  await page.clock.runFor(20_000);expect(await calls(page)).toBe(2);
  await page.evaluate(()=>{window.chatFollow.revoke();window.followFixture.release?.();});
  await expect(page.getByLabel('Follow selected Claude branch')).not.toBeChecked();
  await expect(page.getByLabel('Follow selected Claude branch')).toBeDisabled();
  await expect(page.getByText('Branch 2 row 0:',{exact:false})).toHaveCount(0);
  await page.clock.runFor(20_000);expect(await calls(page)).toBe(2);
});
