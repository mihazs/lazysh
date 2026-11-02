import {createRoot} from 'react-dom/client';
import PushSettingsPanel from '../../src/PushSettingsPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {pushStatus} from '../../src/test/pushData';
/** Actual registration controls; no native permission, credential or provider call. */
export function mountPush(provider:'fcm'|'apns'|'unconfigured-google'){
  const calls:string[]=[];let complete!:(value:unknown)=>void;let disables=0;
  const configurable=provider==='unconfigured-google';
  let metadata={...pushStatus,provider:(configurable?'fcm':provider) as 'fcm'|'apns'|'unifiedpush',
    configured:!configurable,availableProviders:configurable?['unifiedpush','fcm']:undefined,
    reason:configurable?'No Firebase configuration':pushStatus.reason};
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic push browser admission',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'isTauri',{configurable:true,value:true});
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args?:{provider?:string})=>{
    calls.push(command);
    if(command==='push_registration_status')return metadata;
    if(command==='push_registration_provider'&&configurable&&args?.provider==='unifiedpush') {
      metadata={...metadata,provider:'unifiedpush',configured:true,reason:'Choose your distributor'};return metadata;
    }
    if(command==='push_registration_register')return new Promise(resolve=>{complete=resolve;});
    if(command==='push_registration_disable'){
      disables++;
      if(disables===2)throw new Error('PRIVATE_PROVIDER_DETAIL');
      metadata={...metadata,tokenPresent:disables===1,reason:disables===1?'Native {{reason}} <pending revocation>':pushStatus.reason};return metadata;
    }
    throw new Error('Unexpected synthetic registration command');
  }}});
  const view=document.createElement('article');view.className='push-fixture';view.style.cssText='position:fixed;inset:0;z-index:100;overflow:auto;background:var(--background);padding:14px';document.body.append(view);
  const root=createRoot(view);root.render(<PushSettingsPanel/>);
  return {calls,completeRetired(){complete({...metadata,enabled:true,tokenPresent:true,reason:'Retired registration response'});},dispose(){root.unmount();view.remove();}};
}
