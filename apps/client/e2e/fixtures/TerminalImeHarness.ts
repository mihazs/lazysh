import {createTerminal,observeTerminalInput} from '../../src/terminal';
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
  let acceptsInput=true;
  const observation=observeTerminalInput(terminal,data=>writes.push(data),()=>acceptsInput);
  const replace=async(value:string)=>{
    const area=terminal.textarea!;
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.value=value;area.setSelectionRange(value.length,value.length);
    area.dispatchEvent(new InputEvent('input',{data:value,inputType:'insertReplacementText',bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,5));
  };
  return {writes,terminal,observation,replace,setAcceptsInput(value:boolean){acceptsInput=value;if(!value)observation.reset();},textarea:terminal.textarea!,dispose(){observation.dispose();terminal.dispose();host.remove();}};
}
