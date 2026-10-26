import {createRoot} from 'react-dom/client';
import {MuxPanel} from '../../src/MultiplexerPanel';
import {muxFixture,herdrFixture,remoteMuxName,remoteMuxError} from '../../src/test/multiplexerFixture';

export function mountMultiplexerHarness() {
  const calls:{command:string;args:unknown}[]=[];
  let complete:(()=>void)|undefined;
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});
    if(command==='multiplexer_tree')return muxFixture;
    if(command==='multiplexer_sessions')return [{name:remoteMuxName}];
    if(command==='herdr_tree')return herdrFixture;
    if(command==='zellij_action')return new Promise<void>(resolve=>{complete=resolve;});
    if(command==='tmux_action')throw remoteMuxError;
    throw new Error(`Unexpected fixture command: ${command}`);
  }}});
  const container=document.createElement('div');document.body.replaceChildren(container);
  createRoot(container).render(<main className="tool-panel">
    <MuxPanel sessionId="browser-control" onAttach={async()=>{throw new Error('No automatic attach');}}/>
  </main>);
  return {calls,finish:()=>complete?.()};
}
