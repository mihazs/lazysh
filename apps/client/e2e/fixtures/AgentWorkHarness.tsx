import {createRoot} from 'react-dom/client';
import ChatPanel from '../../src/ChatPanel';
import {accessSnapshot,applyAccessStatus} from '../../src/access';

/** The Agent view's timeline reader bound to a synthetic conversation; the page's `agent_transcript` answers come from the test. */
export function mountAgentWorkHarness() {
  applyAccessStatus({initialized:true,supported:true,reason:'Synthetic browser access fixture.',enabled:true,locked:false,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'a'.repeat(64)});
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',display:'grid',zIndex:'100',background:'var(--background)'});
  document.body.append(host);
  const root=createRoot(host);
  root.render(<ChatPanel sessionId="fixture-host" bound={{agent:'claude',path:'/fixture/claude.jsonl'}} timeline allowStage={false}/>);
  return {dispose(){root.unmount();host.remove();}};
}
