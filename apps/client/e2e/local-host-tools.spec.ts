import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl} from './fixtures/workspaceControl';
import {fileReviewName,fileReviewReply} from '../src/test/fileReviewData';

declare global { interface Window { localToolCalls:{command:string;sessionId:unknown}[] } }
const sessionId='local:12345678-1234-4234-8234-123456789abc';

async function openLocal(page:Page,tools:{files:boolean;repository:boolean}) {
  await installNativeBridge(page);
  const replies=Object.fromEntries(['list_directory','read_file','repository_status','repository_history','repository_diff'].map(command=>[command,fileReviewReply(command)]));
  await page.addInitScript(({sessionId,tools,replies})=>{
    window.localToolCalls=[];
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:true,reason:'Synthetic local fixture; no shell runs.',targets:[{id:'default',label:'bash',kind:'posix',tools}]};
      if(command==='local_connect')return {sessionId};
      if(command.startsWith('plugin:event|')||['local_resize','local_ack','local_write','local_disconnect'].includes(command))return;
      if(command==='account_usage')return {schemaVersion:1,state:'unavailable',source:null,report:null};
      if(command in replies){window.localToolCalls.push({command,sessionId:args.sessionId});return replies[command];}
      throw new Error(`Unexpected local fixture command: ${command}`);
    };
  },{sessionId,tools,replies});
  await page.goto('/');
  if(test.info().project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.getByText('Local PTY')).toBeVisible();
}

test('a local session opens Files and Diff when its target reports them',async({page})=>{
  await openLocal(page,{files:true,repository:true});
  await (await workspaceControl(page,'Files')).click();
  const files=page.getByRole('region',{name:'Remote files',exact:true});
  await files.getByRole('button',{name:new RegExp(fileReviewName)}).click();
  await expect(files.getByText('const literal',{exact:false})).toBeVisible();
  await expect(files.getByRole('button',{name:'Upload',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Return to terminal',exact:true}).click();
  await (await workspaceControl(page,'Diff')).click();
  const repo=page.getByRole('region',{name:'Repository review',exact:true});
  await repo.getByRole('button',{name:'Open repository',exact:true}).click();
  await repo.getByRole('button',{name:'Unstaged diff',exact:true}).click();
  await expect(repo.getByRole('table',{name:'Side by side diff',exact:true}).getByText('after literal',{exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>window.localToolCalls);
  expect(new Set(calls.map(call=>call.command))).toEqual(new Set(['list_directory','read_file','repository_status','repository_history','repository_diff']));
  expect(calls.every(call=>call.sessionId===sessionId)).toBe(true);
});

test('a local session hides Files and Diff when its target does not report them',async({page})=>{
  await openLocal(page,{files:false,repository:false});
  // The workspace tools are shown (Dictate is a local tool); Files and Diff are not among them.
  await workspaceControl(page,'Dictate');
  await expect(page.getByRole('button',{name:'Files',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Diff',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>window.localToolCalls)).toEqual([]);
});
