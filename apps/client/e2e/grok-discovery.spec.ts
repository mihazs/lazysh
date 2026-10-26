import {expect,test,type Page} from '@playwright/test';
import type {mountChatFollowHarness} from './fixtures/ChatFollowHarness';
declare global {interface Window {
  grokOwner:ReturnType<typeof mountChatFollowHarness>;
  grokDiscovery:{calls:{command:string;args:Record<string,unknown>;options:unknown}[];hold:boolean;finish?:()=>void;holdRead:boolean;reads:number;fail:boolean};
}}
async function grokFixture(page:Page) {
  await page.goto('/');
  await page.evaluate(async()=>{
    window.grokDiscovery={calls:[],hold:false,holdRead:false,reads:0,fail:false};
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>,options:unknown)=>{
      const state=window.grokDiscovery;state.calls.push({command,args,options});
      if(command==='agent_transcripts') {
        const result={schemaVersion:1,agent:'grok-acp',sessions:[{name:'opaque-folder',path:'/fixture/.grok/sessions/cwd/opaque-folder/updates.jsonl',bytes:42,modifiedAt:'2026-10-26T00:00:00Z'}]};
        if(state.hold)return new Promise(resolve=>{state.finish=()=>resolve(result);});
        return result;
      }
      if(command==='agent_transcript') {
        if(state.fail)throw new Error('Unsupported synthetic timeline control');
        state.reads++;
        const text=args.view==='conversation'?`Reduced Grok branch ${state.reads}`:'Recorded Grok text';
        const result={schemaVersion:1,agent:'grok-acp',view:args.view==='conversation'?'active_branch':'record_stream',nextOffset:42,hasMore:false,messages:[{id:'record-0',role:'assistant',blocks:[{type:'text',text}]}]};
        if(state.holdRead)return new Promise(resolve=>{state.finish=()=>resolve(result);});
        return result;
      }
      throw new Error(`Unexpected Grok fixture command: ${command}`);
    }}});
    const {mountChatFollowHarness}=await import('/e2e/fixtures/ChatFollowHarness.tsx');
    window.grokOwner=mountChatFollowHarness();
  });
  await page.getByRole('combobox',{name:'Agent',exact:true}).selectOption('grok-acp');
}
test('Grok discovery lists metadata without opening a file or selecting conversation replay',async({page})=>{
  await grokFixture(page);
  expect(await page.evaluate(()=>window.grokDiscovery.calls)).toEqual([]);
  await page.getByRole('button',{name:'Find transcripts',exact:true}).click();
  await page.getByRole('combobox',{name:'Recent transcripts',exact:true}).selectOption('0');
  expect(await page.evaluate(()=>window.grokDiscovery.calls.map(call=>call.command))).toEqual(['agent_transcripts']);
  await expect(page.getByLabel('Transcript path',{exact:true})).toHaveValue('/fixture/.grok/sessions/cwd/opaque-folder/updates.jsonl');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect(page.getByText('Recorded Grok text',{exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>window.grokDiscovery.calls);
  expect(calls[1]).toMatchObject({command:'agent_transcript',args:{sessionId:'fixture-host',agent:'grok-acp',path:'/fixture/.grok/sessions/cwd/opaque-folder/updates.jsonl',offset:0}});
  await expect(page.getByRole('combobox',{name:'View',exact:true})).toHaveValue('records');
  await expect(page.getByLabel('Follow selected Claude branch')).toHaveCount(0);
});
async function chooseGrokConversation(page:Page) {
  await grokFixture(page);
  await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/updates.jsonl');
  await page.getByRole('combobox',{name:'View',exact:true}).selectOption('conversation');
}
test('explicit Grok conversation refresh replaces the branch and unsupported reduction retains Records fallback',async({page})=>{
  await chooseGrokConversation(page);
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect(page.getByText('Reduced Grok branch 1',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Refresh new messages',exact:true}).click();
  await expect(page.getByText('Reduced Grok branch 2',{exact:true})).toBeVisible();
  await expect(page.getByText('Reduced Grok branch 1',{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Follow selected Claude branch')).toHaveCount(0);
  const calls=await page.evaluate(()=>window.grokDiscovery.calls);
  expect(calls.map(call=>call.args)).toEqual([1,2].map(()=>({sessionId:'fixture-host',agent:'grok-acp',path:'/fixture/updates.jsonl',offset:0,view:'conversation'})));
  expect(calls[0].options).toEqual(calls[1].options);
  await page.evaluate(()=>{window.grokDiscovery.fail=true;});
  await page.getByRole('button',{name:'Refresh new messages',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('Unsupported synthetic timeline control');
  await expect(page.getByText(/Unsupported controls or ambiguous rewinds/)).toBeVisible();
  await page.evaluate(()=>{window.grokDiscovery.fail=false;});
  await page.getByRole('combobox',{name:'View',exact:true}).selectOption('records');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect(page.getByText('Recorded Grok text',{exact:true})).toBeVisible();
});
test('a held Grok conversation cannot publish or retry after its original access lease is revoked',async({page})=>{
  await chooseGrokConversation(page);await page.evaluate(()=>{window.grokDiscovery.holdRead=true;});
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.grokDiscovery.finish)).toBe('function');
  await page.evaluate(()=>{window.grokOwner.revoke();window.grokDiscovery.finish!();});
  await expect(page.getByRole('button',{name:'Open transcript',exact:true})).toBeDisabled();
  await expect(page.getByText('Reduced Grok branch 1',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>window.grokDiscovery.calls.length)).toBe(1);
});
test('a held Grok discovery result cannot reappear after its original access lease is revoked',async({page})=>{
  await grokFixture(page);await page.evaluate(()=>{window.grokDiscovery.hold=true;});
  await page.getByRole('button',{name:'Find transcripts',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.grokDiscovery.finish)).toBe('function');
  await page.evaluate(()=>{window.grokOwner.revoke();window.grokDiscovery.finish!();});
  await expect(page.getByRole('button',{name:'Find transcripts',exact:true})).toBeDisabled();
  await expect(page.getByRole('combobox',{name:'Recent transcripts',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>window.grokDiscovery.calls.map(call=>call.command))).toEqual(['agent_transcripts']);
});
