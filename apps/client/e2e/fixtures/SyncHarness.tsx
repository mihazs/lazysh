import {createRoot} from 'react-dom/client';
import SyncPanel from '../../src/SyncPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {syncPreview,syncRecovery} from '../../src/test/syncData';
/** Synthetic native sync only; no WebDAV server, cryptography or user credentials. */
export function mountSyncHarness(){
  const calls:{command:string;args:unknown}[]=[];let changed=0;let complete:undefined|(()=>void);
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic encrypted-sync authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'e'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:{scope?:'settings'|'credentials'})=>{
    calls.push({command,args});
    if(command==='sync_status')return {configured:false,settingsEnabled:false,credentialsEnabled:false};
    if(command==='sync_configure')return new Promise(resolve=>{complete=()=>resolve({recoveryKey:syncRecovery,recipient:'synthetic-recipient'});});
    if(command==='sync_preview')return new Promise(resolve=>{complete=()=>resolve(syncPreview(args.scope));});
    if(command==='sync_apply')return new Promise(resolve=>{complete=()=>resolve({hostsAdded:1000,credentialsAdded:1});});
    if(command==='sync_recovery_key')return {recoveryKey:syncRecovery};
    if(command==='sync_push'||command==='sync_forget')return;
    throw new Error(`Unexpected sync fixture command: ${command}`);
  }}});
  const host=document.createElement('div');host.className='sync-fixture';Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',background:'var(--theme-bg)',zIndex:'100'});document.body.append(host);const root=createRoot(host);root.render(<SyncPanel onHostsChanged={()=>{changed++;}}/>);
  return {calls,get hostChanges(){return changed;},finish(){complete?.();complete=undefined;},dispose(){root.unmount();host.remove();}};
}
