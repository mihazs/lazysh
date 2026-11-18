import {createTerminal} from '../../src/xterm/terminal';
import {XtermTerminalAdapter} from '../../src/xtermTerminalAdapter';
import type {UnappliedTerminalEdit} from '../../src/terminalAdapter';
import '../../src/xterm/styles';

/** Synthetic text only. No native transport, host, input history or private keyboard data. */
export function mountTerminalImeHarness(unsupportedShape = false, options: {macOptionIsMeta?:boolean;screenReaderMode?:boolean} = {}) {
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'100',background:'#101010'});
  document.body.append(host);
  const terminal=createTerminal(),adapter=new XtermTerminalAdapter(terminal),writes:string[]=[];
  Object.assign(terminal.options,options);
  terminal.open(host);adapter.focus();
  if(unsupportedShape)delete (terminal as unknown as {_core:{_compositionHelper:{_isSendingComposition?:boolean}}})._core._compositionHelper._isSendingComposition;
  let acceptsInput=true, proposal:UnappliedTerminalEdit|null=null;
  const observation=adapter.observeInput!(data=>writes.push(data),()=>acceptsInput,edit=>{proposal=edit;});
  const replace=async(value:string,inputType='insertReplacementText',cursor=value.length)=>{
    const area=adapter.inputElement()!;
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.value=value;area.setSelectionRange(cursor,cursor);
    area.dispatchEvent(new InputEvent('input',{data:value,inputType,bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,5));
  };
  return {get proposal(){return proposal;},writes,adapter,/** The xterm behind `adapter`, for the cases that probe xterm's own options and private helper. */terminal,observation,replace,setAcceptsInput(value:boolean){acceptsInput=value;if(!value)observation.reset();},textarea:adapter.inputElement()!,dispose(){observation.dispose();terminal.dispose();host.remove();}};
}
