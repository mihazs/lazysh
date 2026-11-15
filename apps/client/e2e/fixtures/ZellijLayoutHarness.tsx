import {muxFixture} from '../../src/test/multiplexerFixture';
import {renderMuxPanel} from './MultiplexerHarness';

/** A Zellij 0.45.1 host: the version gate allows every layout action, and a closed pane leaves the list the next read returns. */
export function mountZellijLayoutHarness() {
  const calls:{command:string;args:unknown}[]=[];
  let panes=[
    {id:0,title:'Pane #1',command:'zsh',tab:'Tab #1',focused:true,columns:120,rows:40},
    {id:3,title:'logs',command:'tail -f build.log',tab:'Tab #1',focused:false,columns:120,rows:40},
  ];
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});
    if(command==='multiplexer_tree')return {...muxFixture,tools:[{kind:'zellij',version:'0.45.1',support:'full',missing:[]}]};
    if(command==='multiplexer_sessions')return [{name:'builds'}];
    if(command==='zellij_panes')return panes;
    if(command==='zellij_action'){
      const action=(args as {action:{type:string;target?:number}}).action;
      if(action.type==='closePane')panes=panes.filter(pane=>pane.id!==action.target);
      return;
    }
    throw new Error(`Unexpected fixture command: ${command}`);
  }}});
  renderMuxPanel();
  return {calls};
}
