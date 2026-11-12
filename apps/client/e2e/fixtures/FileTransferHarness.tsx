import {createRoot} from 'react-dom/client';
import {FilesPanel} from '../../src/SessionTools';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';

import {transferName,transferSession} from '../../src/test/fileTransferData';
type Stat={path:string;name:string;kind:string;size:number;link:string|null;actions:string[]};
const statFor=(path:string,over:Partial<Stat>={}):Stat=>({path,name:path.split('/').pop()!,kind:'file',size:2_500_000,link:null,actions:['save','open'],...over});

/** The real Files panel over a synthetic native layer: transfers are held until the test releases them. */
export function mountFileTransfer(overrides:Partial<Stat>={}) {
  const calls:{command:string;args:Record<string,unknown>}[]=[];
  let stat:Partial<Stat>=overrides,held:{progress:(bytes:number,total:number)=>void;finish:()=>void;fail:(error:unknown)=>void}|null=null,hold=false,deliverFailure:unknown=null;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic file-transfer browser fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{transformCallback:()=>1,unregisterCallback(){},invoke:async(command:string,args:Record<string,unknown>)=>{
    calls.push({command,args:{...args,progress:undefined}});
    if(command==='list_directory')return [{name:transferName,isDir:false,size:2_500_000}];
    if(command==='read_file')return 'binary-looking preview text';
    if(command==='host_file_stat')return statFor(String(args.path),stat);
    if(command==='host_file_cancel'){return;}
    if(command==='host_file_deliver'){if(deliverFailure)throw deliverFailure;return {location:args.action==='save'?`/home/zoë/Downloads/${transferName}`:null};}
    if(command==='host_file_download'){
      const progress=args.progress as {onmessage:(value:unknown)=>void};
      const total=(stat.size??2_500_000);
      progress.onmessage({bytes:0,total});
      if(!hold){progress.onmessage({bytes:total,total});return {name:transferName,size:total};}
      return new Promise((resolve,reject)=>{held={progress:(bytes,size)=>progress.onmessage({bytes,total:size}),finish:()=>resolve({name:transferName,size:total}),fail:reject};});
    }
    throw new Error(`Unexpected transfer fixture command: ${command}`);
  }}});
  const host=document.createElement('div');host.className='file-transfer-fixture';
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});
  document.body.append(host);
  const root=createRoot(host);root.render(<FilesPanel sessionId={transferSession}/>);
  return {calls,
    set(next:Partial<Stat>){stat=next;},
    holdDownloads(){hold=true;},
    failDelivery(error:unknown){deliverFailure=error;},
    progress(bytes:number,total:number){held?.progress(bytes,total);},
    finish(){held?.finish();},
    fail(error:unknown){held?.fail(error);},
    dispose(){root.unmount();host.remove();}};
}
