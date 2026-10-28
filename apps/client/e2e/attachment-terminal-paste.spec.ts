import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {attachmentReceipt,attachmentUploadedPath} from '../src/test/attachmentData';
declare global{interface Window{attachmentPasteApp:{writes:{sessionId:unknown;data:unknown;headers:unknown}[];emit:(text:string)=>void};}}

for(const scenario of [
  {name:'plain paste',bracketed:false,path:attachmentUploadedPath,valid:true},
  {name:'bracketed paste',bracketed:true,path:attachmentUploadedPath,valid:true},
  {name:'forged C1 control rejected',bracketed:true,path:'/host/unsafe\x9b201~path',valid:false},
])test(`actual App original attachment path: ${scenario.name}`,async({page})=>{
  const nonce='a'.repeat(64);
  await installNativeBridge(page,Object.assign({reason:'Synthetic attachment terminal fixture',generation:'1'},{supported:true,enabled:true,nonce}));
  await page.addInitScript(({receipt,path})=>{
    window.attachmentPasteApp={writes:[],emit:()=>{}};
    window.nativeFixtureInvoke=async(command,args,options)=>{
      if(command==='list_hosts')return [{id:'attachment-host',name:'Paste fixture',hostname:'fixture.invalid',username:'agent',port:22,transport:'ssh'}];
      if(command==='local_capability')return {available:false,reason:'Synthetic fixture; no host process.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect'){
        const channel=args.events as {onmessage:(event:unknown)=>void};
        window.attachmentPasteApp.emit=text=>channel.onmessage({type:'data',data:[...new TextEncoder().encode(text)]});
        return {sessionId:'ssh:attachment-paste'};
      }
      if(command==='write_stdin'){window.attachmentPasteApp.writes.push({sessionId:args.sessionId,data:args.data,headers:options?.headers});return;}
      if(['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      if(command==='upload_reserve')return {uploadId:receipt};
      if(command==='upload_file')return {path};
      if(command==='upload_cancel')return {outcome:'unknown_or_settled'};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected attachment terminal fixture command: ${command}`);
    };
  },{receipt:attachmentReceipt,path:scenario.path});
  await page.goto('/');
  if(test.info().project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Paste fixture',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-owned-fixture');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(page.getByLabel('Terminal keys',{exact:true})).toBeVisible();
  await page.evaluate(bracketed=>window.attachmentPasteApp.emit((bracketed?'\x1b[?2004h':'\x1b[?2004l')+'paste-ready'),scenario.bracketed);
  await expect(page.locator('.xterm-screen')).toContainText('paste-ready');
  await page.getByRole('button',{name:'Attach',exact:true}).click();
  await page.getByLabel('Choose attachment',{exact:true}).setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('literal upload bytes')});
  await page.getByRole('button',{name:'Upload attachment',exact:true}).click();
  const prompt=page.getByRole('textbox',{name:'Editable prompt',exact:true});
  await prompt.fill('  keep this editable prompt unchanged  ');
  expect(await page.evaluate(()=>window.attachmentPasteApp.writes)).toEqual([]);
  await page.getByRole('button',{name:'Paste uploaded path',exact:true}).click();
  const literal="'/sftp/home/actual {{path}}'\\''s <file>.png'";
  if(scenario.valid){
    await expect.poll(()=>page.evaluate(()=>window.attachmentPasteApp.writes)).toEqual([{sessionId:'ssh:attachment-paste',data:scenario.bracketed?`\x1b[200~${literal}\x1b[201~`:literal,headers:{'X-Lazysh-Access':nonce}}]);
    await expect(page.getByText('Path sent without Enter. Check the terminal before continuing.',{exact:true})).toBeVisible();
  }else{
    await expect(page.getByRole('alert')).toHaveText('The upload did not return a valid single-line absolute path for terminal paste.');
    expect(await page.evaluate(()=>window.attachmentPasteApp.writes)).toEqual([]);
  }
  await expect(prompt).toHaveValue('  keep this editable prompt unchanged  ');
});
