import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import TerminalPane from '../../src/TerminalPane';
import type {LiveSession} from '../../src/terminal';
import {createXtermFixture} from './xtermFixture';
import {accessSnapshot,applyAccessStatus} from '../../src/access';
import type {MultiplexerKind} from '../../src/bridge';
import '../../src/styles.css';

/**
 * One terminal attached to a synthetic multiplexer, in the pane the app gives a session. Zellij is never restored by the app (the user
 * reopens it from Sessions), so its tab strip is exercised here; every command still goes through the page's native fixture.
 */
export function mountTabStripHarness(kind:MultiplexerKind,name:string,sessionId:string) {
  applyAccessStatus({initialized:true,supported:true,reason:'Synthetic tab strip access fixture.',enabled:true,locked:false,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'b'.repeat(64)});
  const host=document.createElement('section');
  host.style.cssText='position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;background:#101010';
  document.body.append(host);
  const {terminal,adapter}=createXtermFixture();
  const session:LiveSession={id:sessionId,hostId:'fixture',name:'Tab strip fixture',destination:'fixture',terminal,adapter,connected:true,attached:{kind,name}};
  const root=createRoot(host);
  flushSync(()=>root.render(<TerminalPane session={session} active reportError={()=>{}}/>));
  return {dispose(){root.unmount();terminal.dispose();host.remove();}};
}
