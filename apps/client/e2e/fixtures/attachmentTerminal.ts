import {expect,type Page,test} from '@playwright/test';
import {installNativeBridge} from './nativeBridge';
import {attachmentReceipt} from '../../src/test/attachmentData';
declare global{interface Window{attachmentTerminal:{writes:{sessionId:unknown;data:unknown;steps:unknown;headers:unknown}[];uploads:unknown[];emit:(text:string)=>void};}}

/**
 * One saved SSH host whose terminal accepts uploads. The upload reports
 * `uploadedPath`, or `/tmp/lazysh/<name>` when none is given, so specs can
 * check that the client uses the path the host returned.
 */
export async function connectAttachmentTerminal(page:Page,{nonce,uploadedPath,ready}:{nonce:string;uploadedPath?:string;ready:string}) {
  await installNativeBridge(page,{reason:'Synthetic attachment terminal fixture',generation:'1',supported:true,enabled:true,nonce});
  await page.addInitScript(({receipt,uploadedPath})=>{
    window.attachmentTerminal={writes:[],uploads:[],emit:()=>{}};
    window.nativeFixtureInvoke=async(command,args,options)=>{
      if(command==='list_hosts')return [{id:'attachment-host',name:'Attachment fixture',hostname:'fixture.invalid',username:'agent',port:22,transport:'ssh'}];
      if(command==='local_capability')return {available:false,reason:'Synthetic fixture; no host process.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect'){
        const channel=args.events as {onmessage:(event:unknown)=>void};
        window.attachmentTerminal.emit=text=>channel.onmessage({type:'data',data:[...new TextEncoder().encode(text)]});
        return {sessionId:'ssh:attachment-terminal'};
      }
      if(command==='write_stdin'){window.attachmentTerminal.writes.push({sessionId:args.sessionId,data:args.data,steps:args.steps,headers:options?.headers});return;}
      if(['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      if(command==='upload_reserve')return {uploadId:receipt};
      if(command==='upload_file'){window.attachmentTerminal.uploads.push({path:args.path,temporary:args.temporary===true});return {path:uploadedPath??`/tmp/lazysh/${String(args.path).split('/').pop()}`};}
      if(command==='upload_cancel')return {outcome:'unknown_or_settled'};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected attachment terminal fixture command: ${command}`);
    };
  },{receipt:attachmentReceipt,uploadedPath});
  await page.goto('/');
  if(test.info().project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Attachment fixture',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-owned-fixture');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(page.getByLabel('Terminal keys',{exact:true})).toBeVisible();
  await page.evaluate(ready=>window.attachmentTerminal.emit(ready),ready);
}
