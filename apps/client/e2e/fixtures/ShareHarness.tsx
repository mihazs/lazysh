import {createRoot} from 'react-dom/client';
import SharePanel from '../../src/SharePanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {shareOrigin,sharedImage,shareThumbnail} from '../../src/test/shareData';
/** Actual Share renderer; configured service, uploads and clipboard are synthetic. */
export function mountShare(){
  const calls:{command:string;args:unknown}[]=[];const copied:string[]=[];let finish!:(value:unknown)=>void;let fail!:(reason:unknown)=>void;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic sharing authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});if(command==='share_status')return {configured:true,origin:shareOrigin};if(command==='share_list')return {schemaVersion:1,shares:[sharedImage],nextCursor:null};if(command==='share_thumbnail')return shareThumbnail;if(command==='share_configure')return {configured:true,origin:shareOrigin};if(command==='share_upload_begin')return {id:'browser-pending'};if(command==='share_upload_finish')return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});if(['share_upload_chunk','share_upload_cancel','share_delete','share_forget','share_thumbnail_cancel'].includes(command))return;throw new Error('Unexpected share fixture command');
  }}});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied.push(text);}}});
  const host=document.createElement('div');host.className='share-fixture';Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});document.body.append(host);const root=createRoot(host);root.render(<SharePanel/>);
  return {calls,copied,complete(){finish({schemaVersion:1,share:sharedImage});},fail(){fail('Raw sharing diagnostic with secret material');},dispose(){root.unmount();host.remove();}};
}
