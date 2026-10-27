import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {tmuxChatBound,tmuxChatSnapshot,tmuxChatSource} from '../src/test/tmuxChat';
declare global {interface Window {terminalInputFixture:{actions:Record<string,unknown>[];writes:number}}}
test('an actual tmux Chat confirms one destination before literal Send/Stop and retires on source change',async({page},testInfo)=>{
  await installNativeBridge(page);
  const snapshot={...tmuxChatSnapshot,windowName:"Window 世界 '$(touch NEVER); "+'W'.repeat(80)};
  await page.addInitScript(({snapshot,bound})=>{
    window.terminalInputFixture={actions:[],writes:0};
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic tmux-input browser fixture.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'control-session'};
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,sessions:[{id:'$1',name:'work',windows:[]}]};
      if(command==='attach_tmux')return {sessionId:'confirmed-display'};
      if(command==='agent_transcript')return {schemaVersion:1,agent:'claude',view:'record_stream',messages:[],nextOffset:0,hasMore:false};
      if(command==='tmux_chat'){
        expectSource(args.sessionId);
        const action=args.action as Record<string,unknown>;window.terminalInputFixture.actions.push(action);
        return action.kind==='snapshot'?snapshot:action.kind==='bind'?bound:action.kind==='release'?{kind:'released'}:{kind:'delivered',nextOperation:Number(action.operation)+1};
      }
      if(command==='write'){window.terminalInputFixture.writes++;return;}
      if(command==='apple_status_capability')return {available:false,reason:'Synthetic fixture.'};
      if(command.startsWith('plugin:event|') || ['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      throw new Error(`Unexpected synthetic terminal-input command: ${command}`);
    };
    function expectSource(sessionId:unknown){if(sessionId!=='confirmed-display')throw new Error('Wrong synthetic terminal destination');}
  },{snapshot,bound:tmuxChatBound});
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Fixture',exact:true}).click();await page.getByLabel('Password',{exact:true}).fill('synthetic-entry');await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByRole('button',{name:'Sessions',exact:true}).click();await page.getByRole('button',{name:'Attach work',exact:true}).click();await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button',{name:'Transcript',exact:true}).click();await page.getByLabel('Transcript path',{exact:true}).fill(tmuxChatSource.path);await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  const region=page.getByRole('region',{name:'Terminal input',exact:true});await expect(region).toBeVisible();
  await page.getByLabel('Draft for this terminal',{exact:true}).fill('  literal 世界 😀  ');
  expect(await page.evaluate(()=>window.terminalInputFixture)).toEqual({actions:[],writes:0});
  await region.getByRole('button',{name:'Choose terminal destination',exact:true}).click();
  await expect(region.getByText('owner@fixture.invalid',{exact:true})).toBeVisible();await expect(region.getByText('Fixture / work',{exact:true})).toBeVisible();await expect(region.getByText(snapshot.windowName,{exact:true})).toBeVisible();
  expect(await region.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  for(const value of Object.values(snapshot.destination))await expect(region.getByText(value,{exact:true})).toHaveCount(0);
  await region.getByRole('button',{name:'Confirm this destination',exact:true}).click();
  expect(await region.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect((await page.evaluate(()=>window.terminalInputFixture.actions)).map(action=>action.kind)).toEqual(['snapshot','bind']);
  await region.getByRole('button',{name:'Send to terminal',exact:true}).click();await expect(region.getByText('Text and Enter sent to the confirmed pane.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Draft for this terminal',{exact:true})).toHaveValue('');
  await region.getByRole('button',{name:'Request stop',exact:true}).click();await expect(region.getByText('Escape sent to the confirmed pane. The process may still be running.',{exact:true})).toBeVisible();
  const actions=await page.evaluate(()=>window.terminalInputFixture.actions);
  expect(actions).toEqual([{kind:'snapshot'},{kind:'bind',destination:snapshot.destination,source:tmuxChatSource},{kind:'input',receipt:tmuxChatBound.receipt,source:tmuxChatSource,operation:1,input:{kind:'send',text:'  literal 世界 😀  '}},{kind:'input',receipt:tmuxChatBound.receipt,source:tmuxChatSource,operation:2,input:{kind:'request_stop'}}]);
  await page.getByLabel('Transcript path',{exact:true}).fill('/different-source.jsonl');await expect(region).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>window.terminalInputFixture.actions.at(-1))).toEqual({kind:'release',receipt:tmuxChatBound.receipt});expect(await page.evaluate(()=>window.terminalInputFixture.writes)).toBe(0);
});
