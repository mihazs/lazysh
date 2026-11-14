import type {Page} from '@playwright/test';
import {installNativeBridge} from './nativeBridge';

export type MoshAppState={resizes:{cols:number;rows:number}[];writes:string[];acknowledged:number;emit:(bytes:number[])=>void;closed:()=>void};
declare global {interface Window {nativeMoshApp:MoshAppState;nativeMoshAnswer?:(cols:number,rows:number)=>Promise<number[]>}}

/** Opens the actual workspace on a synthetic Mosh host whose session starts with `first`; `answer` is the remote's frame for each resize. */
export async function openMoshApp(page:Page,host:string,first:number[],answer?:(cols:number,rows:number)=>number[]) {
  if(answer)await page.exposeFunction('nativeMoshAnswer',answer);
  await installNativeBridge(page,Object.assign({reason:'Synthetic Mosh rendering fixture',generation:'1'},{supported:true,enabled:true,nonce:'b'.repeat(64)}));
  await page.addInitScript(({first,host})=>{
    const state:MoshAppState={resizes:[],writes:[],acknowledged:0,emit:()=>{},closed:()=>{}};
    Object.assign(window,{nativeMoshApp:state});
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [{id:'mosh-host',name:host,hostname:'fixture.invalid',username:'owned',port:22,transport:'mosh'}];
      if(command==='local_capability')return {available:false,reason:'Synthetic browser fixture'};
      if(command==='transport_capabilities')return {mosh:true,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'ssh-control'};
      if(command==='connect_mosh'){
        const channel=args.events as {onmessage:(event:unknown)=>void};
        state.emit=bytes=>channel.onmessage({type:'data',data:bytes});state.closed=()=>channel.onmessage({type:'closed'});
        state.emit(first);return {sessionId:'mosh-child'};
      }
      if(command==='resize'){if(args.sessionId==='mosh-child'){const size={cols:Number(args.cols),rows:Number(args.rows)};state.resizes.push(size);if(window.nativeMoshAnswer)setTimeout(async()=>state.emit(await window.nativeMoshAnswer!(size.cols,size.rows)),20);}return;}
      if(command==='ack_output'){if(args.sessionId==='mosh-child')state.acknowledged+=Number(args.bytes);return;}
      if(command==='write_stdin'){if(args.sessionId==='mosh-child')state.writes.push(String(args.data));return;}
      if(['disconnect','cancel_credential_auth'].includes(command))return;
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error('Unexpected synthetic Mosh fixture command');
    };
  },{first,host});
  await page.goto('/');if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();await page.getByRole('button',{name:`Connect to ${host}`,exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-only');await page.getByRole('button',{name:'Connect',exact:true}).click();
}
