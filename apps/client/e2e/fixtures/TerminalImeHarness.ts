import {createTerminal,observeTerminalInput} from '../../src/terminal';
import type {UnappliedTerminalEdit} from '../../src/terminalIme';
import '@xterm/xterm/css/xterm.css';

/** Synthetic text only. No native transport, host, input history or private keyboard data. */
export function mountTerminalImeHarness(unsupportedShape = false, options: {macOptionIsMeta?:boolean;screenReaderMode?:boolean} = {}) {
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'100',background:'#101010'});
  document.body.append(host);
  const terminal=createTerminal(),writes:string[]=[];
  Object.assign(terminal.options,options);
  terminal.open(host);terminal.focus();
  if(unsupportedShape)delete (terminal as unknown as {_core:{_compositionHelper:{_isSendingComposition?:boolean}}})._core._compositionHelper._isSendingComposition;
  let acceptsInput=true, proposal:UnappliedTerminalEdit|null=null;
  const observation=observeTerminalInput(terminal,data=>writes.push(data),()=>acceptsInput,edit=>{proposal=edit;});
  const replace=async(value:string,inputType='insertReplacementText',cursor=value.length)=>{
    const area=terminal.textarea!;
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.value=value;area.setSelectionRange(cursor,cursor);
    area.dispatchEvent(new InputEvent('input',{data:value,inputType,bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,5));
  };
  return {get proposal(){return proposal;},writes,terminal,observation,replace,setAcceptsInput(value:boolean){acceptsInput=value;if(!value)observation.reset();},textarea:terminal.textarea!,dispose(){observation.dispose();terminal.dispose();host.remove();}};
}
