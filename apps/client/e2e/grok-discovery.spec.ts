import {expect,test,type Page} from '@playwright/test';
import type {mountChatFollowHarness} from './fixtures/ChatFollowHarness';
declare global {interface Window {
  grokOwner:ReturnType<typeof mountChatFollowHarness>;
  grokDiscovery:{calls:{command:string;args:Record<string,unknown>}[];hold:boolean;finish?:()=>void};
}}
async function grokFixture(page:Page) {
  await page.goto('/');
  await page.evaluate(async()=>{
    window.grokDiscovery={calls:[],hold:false};
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>)=>{
      const state=window.grokDiscovery;state.calls.push({command,args});
      if(command==='agent_transcripts') {
        const result={schemaVersion:1,agent:'grok-acp',sessions:[{name:'opaque-folder',path:'/fixture/.grok/sessions/cwd/opaque-folder/updates.jsonl',bytes:42,modifiedAt:'2026-10-26T00:00:00Z'}]};
        if(state.hold)return new Promise(resolve=>{state.finish=()=>resolve(result);});
        return result;
      }
      if(command==='agent_transcript')return {schemaVersion:1,agent:'grok-acp',view:'record_stream',nextOffset:42,hasMore:false,messages:[{id:'record-0',role:'assistant',blocks:[{type:'text',text:'Recorded Grok text'}]}]};
      throw new Error(`Unexpected Grok fixture command: ${command}`);
    }}});
    const {mountChatFollowHarness}=await import('/e2e/fixtures/ChatFollowHarness.tsx');
    window.grokOwner=mountChatFollowHarness();
  });
  await page.getByRole('combobox',{name:'Agent',exact:true}).selectOption('grok-acp');
}
test('Grok discovery lists metadata without opening a file or enabling conversation replay',async({page})=>{
  await grokFixture(page);
  expect(await page.evaluate(()=>window.grokDiscovery.calls)).toEqual([]);
  await page.getByRole('button',{name:'Find transcripts',exact:true}).click();
  await page.getByRole('combobox',{name:'Recent transcripts',exact:true}).selectOption('0');
  expect(await page.evaluate(()=>window.grokDiscovery.calls.map(call=>call.command))).toEqual(['agent_transcripts']);
  await expect(page.getByLabel('Transcript path',{exact:true})).toHaveValue('/fixture/.grok/sessions/cwd/opaque-folder/updates.jsonl');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect(page.getByText('Recorded Grok text',{exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>window.grokDiscovery.calls);
  expect(calls[1]).toEqual({command:'agent_transcript',args:{sessionId:'fixture-host',agent:'grok-acp',path:'/fixture/.grok/sessions/cwd/opaque-folder/updates.jsonl',offset:0}});
  await expect(page.getByRole('combobox',{name:'View',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Follow selected Claude branch')).toHaveCount(0);
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
