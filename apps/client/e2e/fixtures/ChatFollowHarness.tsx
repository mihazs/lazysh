import {createRoot} from 'react-dom/client';
import ChatPanel from '../../src/ChatPanel';
import {accessSnapshot,applyAccessStatus} from '../../src/access';

export function mountChatFollowHarness() {
  const status=(locked=false)=>applyAccessStatus({initialized:true,supported:true,reason:'Synthetic browser access fixture.',enabled:true,locked,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});
  status();
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});
  document.body.append(host);
  const root=createRoot(host);root.render(<ChatPanel sessionId="fixture-host"/>);
  return {revoke(){status(true);status();},dispose(){root.unmount();host.remove();}};
}
