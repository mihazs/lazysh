import {createRoot} from 'react-dom/client';
import ChatPanel from '../../src/ChatPanel';
import UsagePanel from '../../src/UsagePanel';
import NotificationPanel from '../../src/NotificationPanel';
import {accessSnapshot, acknowledgeAccessReady, applyAccessStatus} from '../../src/access';
import {updateInbox} from '../../src/notificationStore';
import {panelInboxRow,panelSession,recordedTranscript,recordedUsage} from '../../src/test/recordedPanelData';

/** Real renderer panels; all host records and native IPC below are synthetic. */
export function mountRecordedPanels() {
  const calls:{command:string;args:unknown}[]=[];
  const drafts:unknown[]=[];
  const opened:unknown[]=[];
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic panel locale fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});
    if(command==='agent_transcript')return recordedTranscript;
    if(command==='agent_usage')return recordedUsage;
    throw new Error('Unexpected recorded-panel fixture command');
  }}});
  updateInbox({version:1,monitoring:false,notifications:false,rows:[panelInboxRow],latest:{},error:''});
  const draft=(event:Event)=>drafts.push((event as CustomEvent).detail);
  const open=(event:Event)=>opened.push((event as CustomEvent).detail);
  window.addEventListener('lazysh-prompt-draft',draft);window.addEventListener('lazysh-inbox-open',open);
  const host=document.createElement('div');host.className='recorded-panels-fixture';
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});
  document.body.append(host);
  const root=createRoot(host);root.render(<><ChatPanel sessionId={panelSession.id}/><UsagePanel sessionId={panelSession.id}/><NotificationPanel sessions={[panelSession]}/></>);
  return {calls,drafts,opened,dispose(){root.unmount();host.remove();window.removeEventListener('lazysh-prompt-draft',draft);window.removeEventListener('lazysh-inbox-open',open);}};
}
