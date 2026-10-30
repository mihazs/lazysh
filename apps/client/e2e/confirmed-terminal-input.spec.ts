import {workspaceControl} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {herdrPrepared,herdrBound,herdrTarget} from '../src/test/herdrChat';
import {tmuxChatBound,tmuxChatSnapshot,tmuxChatSource} from '../src/test/tmuxChat';
declare global {interface Window {terminalInputFixture:{actions:Record<string,unknown>[];writes:number}}}
for(const mode of ['single','multiline','uncertain','herdr','herdr-uncertain','herdr-unavailable'] as const) test(`confirmed terminal ${mode} preserves exact input and source retirement`,async({page},testInfo)=>{
  const herdr=mode.startsWith('herdr'),uncertain=mode.endsWith('uncertain'),unavailable=mode==='herdr-unavailable';
  const draft=mode==='single'?'  literal 世界 😀  ':"- first\n\t'é; $()#{pane_id}\\ 世界\nlast  ";
  await installNativeBridge(page);
  const snapshot={...tmuxChatSnapshot,windowName:"Window 世界 '$(touch NEVER); "+'W'.repeat(80)};
  await page.addInitScript(({snapshot,bound,uncertain,herdr,unavailable,prepared,guardedBound})=>{
    window.terminalInputFixture={actions:[],writes:0};
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic tmux-input browser fixture.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'control-session'};
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:herdr,zellijAvailable:false,sessions:[{id:'$1',name:'work',windows:[]}]};
      if(command==='multiplexer_sessions')return [{name:'work'}];
      if(command==='attach_multiplexer')return {sessionId:'confirmed-display'};
      if(command==='attach_tmux')return {sessionId:'confirmed-display'};
      if(command==='agent_transcript')return {schemaVersion:1,agent:'claude',view:'record_stream',messages:[],nextOffset:0,hasMore:false};
      if(command==='tmux_chat'||command==='herdr_chat'){
        if(command!==(herdr?'herdr_chat':'tmux_chat'))throw new Error('Wrong synthetic input backend');
        expectSource(args.sessionId);
        const action=args.action as Record<string,unknown>;window.terminalInputFixture.actions.push(action);
        if(uncertain && action.kind==='input')throw {message:'Synthetic lost input acknowledgement'};
        if(herdr)return action.kind==='status'?{kind:'status',available:!unavailable}:action.kind==='prepare'?prepared:action.kind==='confirm'?guardedBound:action.kind==='release'?{kind:'released'}:{kind:'delivered',nextOperation:Number(action.operation)+1};
        return action.kind==='snapshot'?snapshot:action.kind==='bind'?bound:action.kind==='release'?{kind:'released'}:{kind:'delivered',nextOperation:Number(action.operation)+1};
      }
      if(command==='write'){window.terminalInputFixture.writes++;return;}
      if(command==='apple_status_capability')return {available:false,reason:'Synthetic fixture.'};
      if(command.startsWith('plugin:event|') || ['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      throw new Error(`Unexpected synthetic terminal-input command: ${command}`);
    };
    function expectSource(sessionId:unknown){if(sessionId!=='confirmed-display')throw new Error('Wrong synthetic terminal destination');}
  },{snapshot,bound:tmuxChatBound,uncertain,herdr,unavailable,prepared:herdrPrepared,guardedBound:herdrBound});
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Fixture',exact:true}).click();await page.getByLabel('Password',{exact:true}).fill('synthetic-entry');await page.getByRole('button',{name:'Connect',exact:true}).click();
  await (await workspaceControl(page,'Sessions')).click();if(herdr)await page.getByRole('button',{name:'List herdr sessions',exact:true}).click();await page.getByRole('button',{name:herdr?'Attach herdr work':'Attach work',exact:true}).click();await expect(page.getByRole('tab')).toHaveCount(2);
  await (await workspaceControl(page,'Transcript')).click();await page.getByLabel('Transcript path',{exact:true}).fill(tmuxChatSource.path);await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  const region=page.getByRole('region',{name:'Terminal input',exact:true});await expect(region).toBeVisible();
  const composer=page.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await composer.fill(draft);
  await expect(region.getByText(herdr?/^Text and Enter are queued together/:/^Text containing line breaks or tabs uses bracketed paste/)).toBeVisible();
  expect(await page.evaluate(()=>window.terminalInputFixture)).toEqual({actions:[],writes:0});
  await region.getByRole('button',{name:'Choose terminal destination',exact:true}).click();
  if(unavailable){await expect(region.getByRole('alert')).toHaveText('Guarded input is unavailable for this Herdr terminal. Use Stage or open the terminal.');expect(await page.evaluate(()=>window.terminalInputFixture)).toEqual({actions:[{kind:'status'}],writes:0});return;}
  await expect(region.getByText('owner@fixture.invalid',{exact:true})).toBeVisible();await expect(region.getByText('Fixture / work',{exact:true})).toBeVisible();await expect(region.getByText(herdr?herdrTarget.tab:snapshot.windowName,{exact:true})).toBeVisible();
  expect(await region.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  for(const value of Object.values(snapshot.destination))await expect(region.getByText(value,{exact:true})).toHaveCount(0);
  await region.getByRole('button',{name:'Confirm this destination',exact:true}).click();
  expect(await region.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect((await page.evaluate(()=>window.terminalInputFixture.actions)).map(action=>action.kind)).toEqual(herdr?['status','prepare','confirm']:['snapshot','bind']);
  await region.getByRole('button',{name:'Send to terminal',exact:true}).click();
  if(uncertain) {
    await expect(region.getByRole('alert')).toHaveText('Synthetic lost input acknowledgement');
    await expect(region.getByText(herdr?/^Delivery was not confirmed/:/^Delivery or cleanup could not be confirmed/)).toBeVisible();
    await expect(composer).toHaveValue(draft);
    await expect(region.getByRole('button',{name:'Send to terminal',exact:true})).toHaveCount(0);
  } else {
    await expect(region.getByText(herdr?'Text and Enter queued for the confirmed terminal.':'Text and Enter sent to the confirmed pane.',{exact:true})).toBeVisible();
    await expect(composer).toHaveValue('');
    await region.getByRole('button',{name:'Request stop',exact:true}).click();await expect(region.getByText(herdr?'Escape queued for the confirmed terminal. The process may still be running.':'Escape sent to the confirmed pane. The process may still be running.',{exact:true})).toBeVisible();
  }
  const actions=await page.evaluate(()=>window.terminalInputFixture.actions);
  const receipt=herdr?herdrBound.receipt:tmuxChatBound.receipt;
  expect(actions).toEqual([...(herdr?[{kind:'status'},{kind:'prepare',source:tmuxChatSource},{kind:'confirm',candidate:herdrPrepared.candidate,source:tmuxChatSource}]:[{kind:'snapshot'},{kind:'bind',destination:snapshot.destination,source:tmuxChatSource}]),{kind:'input',receipt,source:tmuxChatSource,operation:1,input:{kind:'send',text:draft}},uncertain?{kind:'release',receipt}:{kind:'input',receipt,source:tmuxChatSource,operation:2,input:{kind:'request_stop'}}]);
  await page.getByLabel('Transcript path',{exact:true}).fill('/different-source.jsonl');await expect(region).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>window.terminalInputFixture.actions.at(-1))).toEqual({kind:'release',receipt});expect(await page.evaluate(()=>window.terminalInputFixture.writes)).toBe(0);
});
