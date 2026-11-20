import {createRoot} from 'react-dom/client';
import {FilesPanel} from '../../src/SessionTools';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';

export const mediaSession='ssh:media';
/** The real Files panel over a synthetic native layer that serves two real media files and one fake. */
export function mountFilesMedia(files:{webm:string;mp3:string}) {
  const calls:{command:string;args:Record<string,unknown>}[]=[];
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic Files media browser fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{transformCallback:()=>1,unregisterCallback(){},invoke:async(command:string,args:Record<string,unknown>)=>{
    calls.push({command,args});
    if(command==='list_directory')return [{name:'clip.webm',isDir:false,size:597},{name:'tune.mp3',isDir:false,size:620},{name:'fake.mp3',isDir:false,size:40}];
    if(command==='host_file_stat')return {path:String(args.path),name:String(args.path).split('/').pop(),kind:'file',size:1,link:null,actions:['save','open']};
    if(command==='media_playback')return true;
    if(command!=='file_media')throw new Error(`Unexpected media fixture command: ${command}`);
    if(args.fileName==='clip.webm')return {mime:'video/webm',data:files.webm};
    if(args.fileName==='tune.mp3')return {mime:'audio/mpeg',data:files.mp3};
    throw {kind:'media_mislabeled',message:'The file contents do not match its video or audio type'};
  }}});
  const host=document.createElement('div');
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});
  document.body.append(host);
  const root=createRoot(host);root.render(<FilesPanel sessionId={mediaSession}/>);
  return {calls,dispose(){root.unmount();host.remove();}};
}
