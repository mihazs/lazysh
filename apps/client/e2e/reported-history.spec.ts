import {workspaceControl} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';

declare global {interface Window {reportedHistoryCalls:{command:string;args:Record<string,unknown>}[]}}
test('reported Claude history prefills its exact SSH terminal and waits for explicit file Open with safe defaults',async({page},testInfo)=>{
  await installNativeBridge(page);
  await page.addInitScript(()=>{
    window.reportedHistoryCalls=[];
    window.nativeFixtureInvoke=async(command,args)=>{
      window.reportedHistoryCalls.push({command,args});
      if(command==='list_hosts')return [{id:'history-host',name:'History host',hostname:'fixture.invalid',username:'owner',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic reported-history browser fixture.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'ssh-history-exact'};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[{sessionId:'claude-opaque-id',agent:'Claude Code',project:'/workspace',state:'working',updatedAt:'2026-10-24T19:30:00Z',summary:'Reported history fixture',paneId:'%3',eventCount:1}]};
      if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
      if(command==='get_companion_settings')return {schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
      if(command==='board_keep_awake_status')return {available:false,active:false,reason:'Synthetic fixture',epoch:'1/11111111-1111-4111-8111-111111111111',ticket:0};
      if(command==='agent_reported_history')return {schemaVersion:1,status:'available',sessionId:'claude-opaque-id',path:'/workspace/Claude 世界.jsonl ',reportedAt:'2026-10-24T19:30:00Z',paneId:'%3'};
      if(command==='agent_transcript')return {schemaVersion:1,agent:'claude',view:'record_stream',messages:[{id:'recorded',role:'assistant',blocks:[{type:'text',text:'Explicitly opened recorded history.'}]}],nextOffset:1,hasMore:false};
      if(command==='apple_status_capability')return {available:false,reason:'Synthetic fixture'};
      if(command.startsWith('plugin:event|') || ['cancel_credential_auth','resize','ack_output','disconnect'].includes(command))return;
      throw new Error(`Unexpected reported-history browser command: ${command}`);
    };
  });
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to History host',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-entry');await page.getByRole('button',{name:'Connect',exact:true}).click();
  await (await workspaceControl(page,'Agents')).click();
  await page.getByRole('button',{name:'Use reported history',exact:true}).click();
  await expect(page.getByLabel('Transcript path',{exact:true})).toHaveValue('/workspace/Claude 世界.jsonl ');
  await expect(page.getByRole('combobox',{name:'Agent',exact:true})).toHaveValue('claude');
  await expect(page.getByRole('combobox',{name:'View',exact:true})).toHaveValue('records');
  await expect(page.getByLabel('Include recorded images',{exact:true})).not.toBeChecked();
  await expect(page.getByLabel('Follow selected Claude branch',{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Draft for this terminal',{exact:true})).toHaveValue('');
  await expect(page.getByText('This reported history may be old. Its running agent is unverified. Press Open transcript to read the file.',{exact:true})).toBeVisible();
  const before=await page.evaluate(()=>window.reportedHistoryCalls);
  expect(before.filter(({command})=>command==='agent_reported_history').map(({args})=>args)).toEqual([{sessionId:'ssh-history-exact',agentSessionId:'claude-opaque-id'}]);
  expect(before.filter(({command})=>['agent_transcript','agent_transcripts','write'].includes(command))).toEqual([]);
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();await expect(page.getByText('Explicitly opened recorded history.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.reportedHistoryCalls.filter(({command})=>command==='agent_transcript').map(({args})=>args))).toEqual([{sessionId:'ssh-history-exact',agent:'claude',path:'/workspace/Claude 世界.jsonl ',offset:0}]);
});
