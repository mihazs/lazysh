import {createRoot} from 'react-dom/client';
import {FilesPanel,DiffPanel} from '../../src/SessionTools';
import RepositoryPanel from '../../src/RepositoryPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {fileReviewReply,fileReviewSession} from '../../src/test/fileReviewData';

/** Actual file/review renderers with synthetic, recorded native responses. */
export function mountFileReview() {
  const calls:{command:string;args:unknown}[]=[];
  const drafts:unknown[]=[];
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic file-review browser fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'e'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});return fileReviewReply(command);
  }}});
  const stage=(event:Event)=>drafts.push((event as CustomEvent).detail);
  window.addEventListener('lazysh-prompt-draft',stage);
  const host=document.createElement('div');host.className='file-review-fixture';
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});
  document.body.append(host);
  const root=createRoot(host);root.render(<><FilesPanel sessionId={fileReviewSession}/><RepositoryPanel sessionId={fileReviewSession}/><DiffPanel sessionId={fileReviewSession}/></>);
  return {calls,drafts,dispose(){root.unmount();host.remove();window.removeEventListener('lazysh-prompt-draft',stage);}};
}
