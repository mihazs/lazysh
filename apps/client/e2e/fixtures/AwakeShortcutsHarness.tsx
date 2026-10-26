import {createRoot} from 'react-dom/client';
import KeepAwakeControl from '../../src/KeepAwakeControl';
import MultiplexerShortcuts from '../../src/MultiplexerShortcuts';

/** Synthetic acknowledgements only; no OS display requests or terminal connection. */
export function mountAwakeShortcutsHarness() {
  const calls:{command:string;args:Record<string,unknown>}[]=[];
  const epoch='0/11111111-1111-4111-8111-111111111111';
  let ticket=0,active=false,complete:(()=>void)|undefined;
  window.nativeFixtureInvoke=async(command,args)=>{
    calls.push({command,args});
    if(command==='write_stdin')return new Promise<void>(resolve=>{complete=resolve;});
    if(command==='board_keep_awake_status')return {available:true,active,reason:'RAW native reason {{value}}',epoch,ticket:++ticket};
    if(command==='board_keep_awake_acquire' || command==='board_keep_awake_release'){
      active=command==='board_keep_awake_acquire';
      return {available:true,active,reason:'',...(args.request as {epoch:string;ticket:number})};
    }
    throw new Error(`Unexpected awake fixture command: ${command}`);
  };
  const container=document.createElement('div');document.body.replaceChildren(container);
  createRoot(container).render(<main className="tool-panel">
    <KeepAwakeControl sessionId="locale-board"/>
    <MultiplexerShortcuts sessionId="locale-tmux" kind="tmux"/>
    <MultiplexerShortcuts sessionId="locale-herdr" kind="herdr"/>
  </main>);
  return {calls,finish:()=>complete?.()};
}
