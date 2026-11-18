import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl} from './fixtures/workspaceControl';
import {fileReviewName,fileReviewReply} from '../src/test/fileReviewData';
import {attachmentReceipt} from '../src/test/attachmentData';
import {routePreviewPage} from './fixtures/previewPage';

declare global { interface Window { localToolCalls:{command:string;sessionId:unknown;args?:Record<string,unknown>}[] } }
const sessionId='local:12345678-1234-4234-8234-123456789abc';
const none={files:false,repository:false,attachments:false,previews:false};

async function openLocal(page:Page,tools:Partial<typeof none>) {
  await installNativeBridge(page);
  const replies=Object.fromEntries(['list_directory','read_file','repository_status','repository_history','repository_diff'].map(command=>[command,fileReviewReply(command)]));
  await page.addInitScript(({sessionId,tools,replies,receipt})=>{
    window.localToolCalls=[];
    const record=(command:string,args:Record<string,unknown>)=>window.localToolCalls.push({command,sessionId:args.sessionId,args:{...args,events:undefined}});
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:true,reason:'Synthetic local fixture; no shell runs.',targets:[{id:'default',label:'bash',kind:'posix',tools}]};
      if(command==='local_connect')return {sessionId};
      if(command.startsWith('plugin:event|')||['local_resize','local_ack','local_disconnect'].includes(command))return;
      if(['local_write','upload_reserve','upload_file','upload_cancel','list_previews','discover_preview_ports','start_preview','stop_preview'].includes(command))record(command,args);
      if(command==='upload_reserve')return {uploadId:receipt};
      if(command==='upload_file')return {path:`/tmp/lazysh-0123456789ab-${args.path}`};
      if(command==='upload_cancel')return {outcome:'unknown_or_settled'};
      if(command==='list_previews')return [];
      if(command==='discover_preview_ports')return [{port:5173,address:'127.0.0.1',process:'node',pid:4312,http:true}];
      if(command==='start_preview')return {id:'local-preview',remotePort:args.remotePort,remoteAddress:'127.0.0.1',localPort:41234,url:'http://127.0.0.1:41234/',pickerToken:null};
      if(['local_write','stop_preview'].includes(command))return;
      if(command==='account_usage')return {schemaVersion:1,state:'unavailable',source:null,report:null};
      if(command in replies){window.localToolCalls.push({command,sessionId:args.sessionId});return replies[command];}
      throw new Error(`Unexpected local fixture command: ${command}`);
    };
  },{sessionId,tools:{...none,...tools},replies,receipt:attachmentReceipt});
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

test('a local session hides the tools its target does not report',async({page})=>{
  await openLocal(page,{});
  // The workspace tools are shown (Dictate is a local tool); the host tools are not among them.
  await workspaceControl(page,'Dictate');
  for(const name of ['Files','Diff','Preview'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  // The terminal keys keep their Attach key, disabled: no workspace tool opens it.
  await expect(page.getByRole('button',{name:'Attach',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.localToolCalls)).toEqual([]);
});

test('a local session saves an attachment on this device and pastes the returned local path',async({page})=>{
  await openLocal(page,{attachments:true});
  await (await workspaceControl(page,'Attach')).click();
  await expect(page.getByText('Saved on this device. Existing files are never replaced. Maximum 10 MiB.',{exact:true})).toBeVisible();
  await page.getByLabel('Choose attachment',{exact:true}).setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('literal upload bytes')});
  await page.getByRole('button',{name:'Upload attachment',exact:true}).click();
  await page.getByText('More attachment actions',{exact:true}).click();
  // There is no host clipboard to copy to: this device's clipboard holds the path.
  await expect(page.getByRole('button',{name:'Copy host path',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Copy raw path on Mac host',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Paste uploaded path',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.localToolCalls.filter(call=>call.command==='local_write').map(call=>call.args?.data))).toEqual(["'/tmp/lazysh-0123456789ab-note.txt'"]);
  const calls=await page.evaluate(()=>window.localToolCalls.filter(call=>call.command.startsWith('upload_')));
  expect(calls.map(call=>call.command)).toEqual(['upload_reserve','upload_file']);
  expect(calls.every(call=>call.sessionId===sessionId)).toBe(true);
  expect(calls[1].args).toMatchObject({path:'note.txt',temporary:true});
});

test('a local session opens a preview of a dev server on this device and closes it',async({page})=>{
  await routePreviewPage(page);
  await openLocal(page,{previews:true});
  await (await workspaceControl(page,'Preview')).click();
  await expect(page.getByText("Choose your development server's HTTP port on this device. The preview connects to it directly and closes when the session ends.",{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Discover listeners',exact:true}).click();
  await page.getByRole('button',{name:/node \(4312\) · 127\.0\.0\.1:5173/}).click();
  await page.getByRole('button',{name:'Open preview',exact:true}).click();
  await expect(page.getByText('http://127.0.0.1:41234/',{exact:true})).toBeVisible();
  await expect(page.frameLocator('iframe.preview-frame').getByRole('button',{name:'Save changes'})).toBeVisible();
  await page.getByRole('button',{name:'Close preview 5173'}).click();
  await expect(page.getByText('http://127.0.0.1:41234/',{exact:true})).toHaveCount(0);
  const calls=await page.evaluate(()=>window.localToolCalls.filter(call=>/preview/.test(call.command)));
  // The panel may list its previews again when it mounts; the rest happen once, in order.
  expect(calls.map(call=>call.command).filter(command=>command!=='list_previews')).toEqual(['discover_preview_ports','start_preview','stop_preview']);
  expect(calls.some(call=>call.command==='list_previews')).toBe(true);
  expect(calls.every(call=>call.sessionId===sessionId)).toBe(true);
  expect(calls.find(call=>call.command==='start_preview')?.args).toMatchObject({remotePort:5173,remoteAddress:'127.0.0.1'});
});
