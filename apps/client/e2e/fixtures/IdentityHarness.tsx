import {createRoot} from 'react-dom/client';
import CredentialsPanel from '../../src/CredentialsPanel';
import type {Credentials} from '../../src/bridge';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {identityInfo,identityPrivateKey} from '../../src/test/identityData';
/** Actual identity UI with non-key fixture text; never invokes crypto or the OS vault. */
export function mountIdentity(){
  const calls:{command:string;args:unknown}[]=[];const copied:string[]=[];const used:Credentials[]=[];
  let complete!:(value:unknown)=>void;let pending='';let denyClipboard=false;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic identity locale authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'d'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{calls.push({command,args});if(command==='generate_identity'||command==='inspect_identity'){pending=command;return new Promise(resolve=>{complete=resolve;});}throw new Error('Unexpected identity fixture operation');}}});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{if(denyClipboard)throw new Error('Synthetic browser denial');copied.push(text);}}});
  const host=document.createElement('div');host.className='identity-fixture';Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});document.body.append(host);const root=createRoot(host);root.render(<CredentialsPanel onUse={credentials=>{used.push(credentials);}}/>);
  return {calls,copied,used,complete(){complete(pending==='generate_identity'?{privateKey:identityPrivateKey,info:identityInfo}:identityInfo);},denyCopy(){denyClipboard=true;},dispose(){root.unmount();host.remove();}};
}
