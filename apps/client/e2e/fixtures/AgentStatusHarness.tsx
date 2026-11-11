import {createRoot} from 'react-dom/client';
import ChatPanel from '../../src/ChatPanel';
import {accessSnapshot,applyAccessStatus} from '../../src/access';

/** The Agent view's timeline reader on a synthetic Claude conversation; the page's `agent_transcript` answer comes from the test. */
export function mountAgentStatusHarness() {
  applyAccessStatus({initialized:true,supported:true,reason:'Synthetic browser access fixture.',enabled:true,locked:false,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'a'.repeat(64)});
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',display:'grid',zIndex:'100',background:'var(--background)'});
  document.body.append(host);
  createRoot(host).render(<ChatPanel sessionId="fixture-host" bound={{agent:'claude',path:'/fixture/claude.jsonl'}} timeline allowStage={false}/>);
}
