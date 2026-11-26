import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import TerminalPane from '../../src/TerminalPane';
import EdgeGestureHost from './EdgeGestureHost';
import {createTerminal} from '../../src/xterm/terminal';
import {createBrowserTerminal} from './browserTerminalRegistry';
import type {TerminalBackendId} from '../../src/terminalAdapter';
import type {LiveSession} from '../../src/terminal';
import {XtermTerminalAdapter} from '../../src/xtermTerminalAdapter';
import {installMoshResize} from '../../src/xterm/moshResize';
import {accessSnapshot,applyAccessStatus} from '../../src/access';
import '../../src/styles.css';

/** Synthetic remote screen only: no host, transport or private terminal content. */
export async function mountTerminalHistoryHarness({mosh=false,input,topAnchored=false,edgeLog,edgeClose,fixedGrid,engine='xterm'}:{engine?:TerminalBackendId;mosh?:boolean;input?:(data:string)=>void;topAnchored?:boolean;edgeLog?:string[];edgeClose?:boolean;fixedGrid?:{cols:number;rows:number}}={}) {
  applyAccessStatus({initialized:true,supported:true,reason:'Synthetic browser access fixture.',enabled:true,locked:false,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'a'.repeat(64)});
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'100',display:'flex',flexDirection:'column',background:'#101010'});
  document.body.append(host);
  const {cols,rows}=fixedGrid??{cols:40,rows:24};
  const browser=engine==='native'?await createBrowserTerminal(engine,{columns:cols,rows}):undefined;
  const terminal=browser?undefined:createTerminal();
  const adapter=browser?.adapter??new XtermTerminalAdapter(terminal!);
  if(fixedGrid&&terminal)adapter.fit=()=>terminal.resize(cols,rows);
  const session:LiveSession={id:mosh?'mosh-history-fixture':'ssh-history-fixture',hostId:'fixture',name:'History fixture',destination:'fixture',terminal,adapter,connected:true};
  if(mosh)session.moshResize=terminal?installMoshResize(terminal):adapter.enableCanonicalResize!();
  const errors:string[]=[],writes:string[]=[],opened:string[]=[],resizes:{cols:number;rows:number}[]=[];
  // The remote screen model repaints its last rows on each canonical Mosh frame.
  // A top-anchored model is mosh-server's own resize: a shrink drops the bottom rows.
  const remote:string[]=[];
  let frame=0,screenRows:number|undefined;
  const write=(data:string)=>adapter.write!(new TextEncoder().encode(data));
  const repaint=(cols:number,rows:number)=>{
    let visible=remote.slice(-rows);
    if(topAnchored) {
      const top=Math.max(0,remote.length-(screenRows??rows));
      if(rows<(screenRows??rows))remote.length=Math.min(remote.length,top+rows);
      screenRows=rows;visible=remote.slice(top,top+rows);
    }
    const body='\x1b[r\x1b[0m\x1b[H\x1b[2J'+visible.map(line=>line.slice(0,cols)+'\x1b[K').join('\r\n')+`\x1b[${Math.max(1,visible.length)};1H`;
    const id=++frame;
    return write(`\x1b]7777;lazysh-mosh;1;begin;${id};${cols};${rows}\x1b\\${body}\x1b]7777;lazysh-mosh;1;end;${id}\x1b\\`);
  };
  const app=window.nativeFixtureInvoke;
  window.nativeFixtureInvoke=async(command,args={},options)=>{
    if(command==='native_terminal_surface_place')return {placed:true,ready:true,generation:1,width:1,height:1};
    if(command==='native_terminal_surface_remove')return;
    if(command==='resize'){
      const size={cols:Number(args.cols),rows:Number(args.rows)};resizes.push(size);
      // Mosh answers a resize intent with an authoritative frame after a round trip.
      if(mosh)setTimeout(()=>void repaint(size.cols,size.rows),20);
      return;
    }
    if(command==='write_stdin'){writes.push(Array.isArray(args.steps)?args.steps.join(''):String(args.data??''));input?.(writes.at(-1)!);return;}
    if(command==='open_web_url'){opened.push(String(args.url));return;}
    // The workspace beneath this overlay keeps its own synthetic commands.
    return app(command,args,options);
  };
  const root=createRoot(host);
  const pane=<TerminalPane session={session} active reportError={error=>errors.push(String(error))}/>;
  flushSync(()=>root.render(edgeLog?<EdgeGestureHost log={edgeLog} close={edgeClose}>{pane}</EdgeGestureHost>:pane));
  if(browser&&mosh)session.moshResize!.requestSize(cols,rows);
  return {get terminal(){if(!terminal)throw new Error('This check requires the xterm fixture');return terminal;},session,core:browser?.core,errors,writes,opened,resizes,
    /** Uncovers the workspace beneath while the terminal stays mounted. */
    hide(hidden:boolean){host.style.display=hidden?'none':'flex';},
    /** Remote lines arrive as Mosh's bottom-row scroll or as plain SSH output. */
    output(lines:string[]){remote.push(...lines);return write(lines.map(line=>`\r\n${line}${mosh?'\x1b[K':''}`).join(''));},
    raw:write,
    dispose(){root.unmount();session.moshResize?.dispose();void adapter.dispose();window.nativeFixtureInvoke=app;host.remove();}};
}
