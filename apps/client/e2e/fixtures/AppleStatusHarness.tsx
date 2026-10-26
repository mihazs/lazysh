import {createRoot} from 'react-dom/client';
import AppleStatusPanel from '../../src/AppleStatusPanel';
import {appleStatusCapability,appleStatusInputs,appleStatusSession} from '../../src/test/appleStatusData';

/** Browser IPC sink only: no ActivityKit, WatchConnectivity or device is contacted. */
export function mountAppleStatusHarness(){
  const calls:{command:string;args:Record<string,unknown>}[]=[];
  const input=appleStatusInputs();let finishEnable:(()=>void)|undefined;
  Object.defineProperty(window,'__TAURI_EVENT_PLUGIN_INTERNALS__',{configurable:true,value:{unregisterListener(){}}});
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{transformCallback:()=>1,invoke:async(command:string,args:Record<string,unknown>={})=>{
    calls.push({command,args});
    if(command==='plugin:event|listen')return 1;
    if(command==='plugin:event|unlisten')return;
    if(command==='apple_status_capability')return appleStatusCapability;
    if(command==='agent_snapshot')return input.activity;
    if(command==='agent_approvals')return input.approvals;
    if(command==='apple_status_publish')return;
    if(command==='apple_status_configure'){
      if(args.enabled)return new Promise<void>(resolve=>{finishEnable=resolve;});
      throw new Error('Synthetic native cleanup failure');
    }
    throw new Error(`Unexpected Apple status fixture command: ${command}`);
  }}});
  const host=document.createElement('div');document.body.replaceChildren(host);
  const root=createRoot(host);root.render(<AppleStatusPanel sessionId={appleStatusSession} usage={input.usage}/>);
  return {calls,complete:()=>finishEnable?.(),dispose:()=>root.unmount()};
}
