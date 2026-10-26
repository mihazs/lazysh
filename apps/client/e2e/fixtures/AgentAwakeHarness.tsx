import {createRoot} from 'react-dom/client';
import AgentPanel from '../../src/AgentPanel';
import {accessSnapshot,applyAccessStatus} from '../../src/access';
export function mountAgentAwakeHarness() {
  function access(locked:boolean) {
    applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'Synthetic board fixture.',
      generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'c'.repeat(64)})});
  }
  access(false);
  const host=document.createElement('aside');
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'16px'});
  document.body.append(host);
  const root=createRoot(host);
  root.render(<AgentPanel sessionId="awake-fixture"/>);
  return {revoke(){access(true);access(false);},close(){root.unmount();host.remove();}};
}
