import {createRoot} from 'react-dom/client';
import AttachmentPanel from '../../src/AttachmentPanel';
import {FilesPanel} from '../../src/SessionTools';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {attachmentUploadedPath,attachmentReceipt,attachmentSession} from '../../src/test/attachmentData';

/** Real attachment editor; upload and clipboard effects are explicit synthetic sinks. */
export function mountAttachment(options:{files?:boolean;holdReserve?:boolean}={}){
  const calls:{command:string;args:unknown}[]=[];const copied:string[]=[];const staged:unknown[]=[];
  const resources={created:0,revoked:0,reads:0};let finish!:()=>void;let acknowledge!:()=>void;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic attachment authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{calls.push({command,args});if(command==='list_directory')return [];if(command==='upload_reserve')return options.holdReserve?new Promise(resolve=>{acknowledge=()=>resolve({uploadId:attachmentReceipt});}):{uploadId:attachmentReceipt};if(command==='upload_cancel')return {outcome:'unknown_or_settled'};if(command==='upload_file')return new Promise(resolve=>{finish=()=>resolve({path:attachmentUploadedPath});});throw new Error('Unexpected attachment fixture command');}}});
  const create=URL.createObjectURL.bind(URL);const revoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=blob=>{resources.created++;return create(blob);};URL.revokeObjectURL=url=>{resources.revoked++;revoke(url);};
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied.push(text);},read:async()=>{resources.reads++;return [];}}});
  const stage=(event:Event)=>staged.push((event as CustomEvent).detail);window.addEventListener('lazysh-prompt-draft',stage);
  const host=document.createElement('div');host.className='attachment-fixture';Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});document.body.append(host);
  const root=createRoot(host);root.render(options.files?<FilesPanel sessionId={attachmentSession}/>:<AttachmentPanel sessionId={attachmentSession}/>);
  return {calls,copied,staged,resources,acknowledge(){acknowledge();},complete(){finish();},dispose(){root.unmount();host.remove();URL.createObjectURL=create;URL.revokeObjectURL=revoke;window.removeEventListener('lazysh-prompt-draft',stage);}};
}
