import type {Page} from '@playwright/test';
import type {CoreMouseInput} from '../../src/nativeCoreBridge';
import type {TerminalBackendId} from '../../src/terminalAdapter';
import type {CoreKeyInput} from '../../src/terminalPlatformKeys';
import type {HeadlessCore} from '../../src/xterm/nativeCoreHeadless';
import {installNativeBridge} from './nativeBridge';

export type MoshAppState={resizes:{cols:number;rows:number}[];writes:string[];acknowledged:number;nativeBytes:number;nativeMouse:CoreMouseInput[];nativeKeys:CoreKeyInput[];emit:(bytes:number[])=>void;closed:()=>void};
declare global {interface Window {nativeMoshApp:MoshAppState;nativeMoshAnswer?:(cols:number,rows:number)=>Promise<number[]>}}

/** Opens the actual workspace on a synthetic Mosh host whose session starts with `first`; `answer` is the remote's frame for each resize. */
export async function openMoshApp(page:Page,host:string,first:number[],answer?:(cols:number,rows:number)=>number[],engine:TerminalBackendId='xterm') {
  if(answer)await page.exposeFunction('nativeMoshAnswer',answer);
  await installNativeBridge(page,Object.assign({reason:'Synthetic Mosh rendering fixture',generation:'1'},{supported:true,enabled:true,nonce:'b'.repeat(64)}));
  await page.addInitScript(({first,host,engine})=>{
    const state:MoshAppState={resizes:[],writes:[],acknowledged:0,nativeBytes:0,nativeMouse:[],nativeKeys:[],emit:()=>{},closed:()=>{}};
    Object.assign(window,{nativeMoshApp:state});
    let core:HeadlessCore|undefined;
    let output=Promise.resolve();
    const native=engine==='native';
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [{id:'mosh-host',name:host,hostname:'fixture.invalid',username:'owned',port:22,transport:'mosh'}];
      if(command==='local_capability')return {available:false,reason:'Synthetic browser fixture'};
      if(command==='transport_capabilities')return {mosh:true,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'ssh-control'};
      if(native&&(command==='terminal_core_available'||command==='native_terminal_probe'))return {available:true};
      if(native&&command==='terminal_core_open'){
        const module='/src/xterm/nativeCoreHeadless.ts';
        const {createHeadlessCore}=await import(module) as typeof import('../../src/xterm/nativeCoreHeadless');
        if(!(args.config as {canonicalFrames?:boolean}|undefined)?.canonicalFrames)throw new Error('The app did not open a canonical Mosh core.');
        core=createHeadlessCore({columns:Number(args.cols),rows:Number(args.rows),scrollbackLines:Number(args.scrollbackLines)});
        await core.canonicalFrames!();
        return;
      }
      if(native&&command==='terminal_core_snapshot'){await output;return core!.snapshot();}
      if(native&&command==='terminal_core_input'){
        const event=args.input as CoreMouseInput|CoreKeyInput;
        if(event.type==='mouse')state.nativeMouse.push(event);
        else if(event.type==='key')state.nativeKeys.push(event);
        else throw new Error('Unexpected native Mosh fixture input');
        return;
      }
      if(native&&command==='terminal_core_close')return core?.close();
      if(native&&command==='native_terminal_surface_cell')return {width:8*Number(args.dpr),height:16*Number(args.dpr)};
      if(native&&command==='native_terminal_surface_place')return {placed:true,ready:true,generation:1,width:1,height:1};
      if(native&&['terminal_core_set_active','terminal_core_theme','terminal_core_scrollback','native_terminal_surface_look','native_terminal_surface_remove'].includes(command))return;
      if(command==='connect_mosh'){
        const channel=args.events as {onmessage:(event:unknown)=>void};
        if(core){
          const runtime=core;
          runtime.subscribe(event=>channel.onmessage(event));
          state.emit=bytes=>{output=output.then(async()=>{await runtime.output(Uint8Array.from(bytes));state.nativeBytes+=bytes.length;});};
          state.closed=()=>{void output.then(()=>channel.onmessage({type:'closed'}));};
        } else {
          state.emit=bytes=>channel.onmessage({type:'data',data:bytes});
          state.closed=()=>channel.onmessage({type:'closed'});
        }
        state.emit(first);return {sessionId:'mosh-child'};
      }
      if(command==='resize'){if(args.sessionId==='mosh-child'){const size={cols:Number(args.cols),rows:Number(args.rows)};state.resizes.push(size);if(window.nativeMoshAnswer)setTimeout(async()=>state.emit(await window.nativeMoshAnswer!(size.cols,size.rows)),20);}return;}
      if(command==='ack_output'){if(args.sessionId==='mosh-child')state.acknowledged+=Number(args.bytes);return;}
      if(command==='write_stdin'){if(args.sessionId==='mosh-child')state.writes.push(String(args.data));return;}
      if(['disconnect','cancel_credential_auth'].includes(command))return;
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error('Unexpected synthetic Mosh fixture command');
    };
  },{first,host,engine});
  await page.goto('/');if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();await page.getByRole('button',{name:`Connect to ${host}`,exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-only');await page.getByRole('button',{name:'Connect',exact:true}).click();
}
