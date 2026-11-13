import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import TerminalPane from '../../src/TerminalPane';
import {createTerminal,type LiveSession} from '../../src/terminal';
import {XtermTerminalAdapter} from '../../src/xtermTerminalAdapter';
import {accessSnapshot,applyAccessStatus} from '../../src/access';
import {uiErrorText} from '../../src/i18n/localError';
import type {MultiplexerKind} from '../../src/bridge';
import '../../src/styles.css';

/**
 * One terminal under a session header, optionally attached to a synthetic
 * multiplexer. Records the exact input steps, Zellij actions, lazysh session
 * switches and errors each gesture produces. No host or multiplexer runs.
 */
export function mountGestureHarness(kind?:MultiplexerKind) {
  applyAccessStatus({initialized:true,supported:true,reason:'Synthetic gesture access fixture.',enabled:true,locked:false,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'b'.repeat(64)});
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'100',display:'flex',flexDirection:'column',background:'#101010'});
  const header=document.createElement('header');
  Object.assign(header.style,{display:'flex',alignItems:'center',justifyContent:'flex-end',height:'54px',flex:'0 0 auto',color:'#fff'});
  const controls=document.createElement('div');
  header.append(controls);
  const body=document.createElement('div');
  Object.assign(body.style,{display:'flex',flexDirection:'column',flex:'1 1 auto',minHeight:'0'});
  host.append(header,body);
  document.body.append(host);
  const terminal=createTerminal();
  const session:LiveSession={id:'gesture-fixture',hostId:'fixture',name:'Gesture fixture',destination:'fixture',terminal,adapter:new XtermTerminalAdapter(terminal),connected:true,
    ...(kind?{attached:{kind,name:`${kind}-work`}}:{})};
  const steps:string[][]=[],zellij:string[]=[],sessions:string[]=[],errors:string[]=[];
  const app=window.nativeFixtureInvoke;
  window.nativeFixtureInvoke=async(command,args={},options)=>{
    if(command==='write_stdin'){steps.push(Array.isArray(args.steps)?args.steps as string[]:[String(args.data??'')]);return;}
    if(command==='zellij_action'){zellij.push(`${String(args.name)}:${(args.action as {type:string}).type}`);return;}
    if(command==='resize')return;
    return app(command,args,options);
  };
  const switched=(event:Event)=>{sessions.push(String((event as CustomEvent<{action:string}>).detail.action));};
  window.addEventListener('lazysh-terminal-action',switched);
  const root=createRoot(body);
  flushSync(()=>root.render(<TerminalPane session={session} active controlsTarget={controls} reportError={error=>errors.push(uiErrorText(error))}/>));
  return {terminal,steps,zellij,sessions,errors,
    dispose(){root.unmount();window.removeEventListener('lazysh-terminal-action',switched);terminal.dispose();host.remove();}};
}
