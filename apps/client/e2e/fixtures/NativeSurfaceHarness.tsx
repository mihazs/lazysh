import type {NativeCoreBridge} from '../../src/nativeCoreBridge';
import {createBrowserTerminal} from './browserTerminalRegistry';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import TerminalPane from '../../src/TerminalPane';
import type {LiveSession} from '../../src/terminal';
import type {SurfaceAnchor} from '../../src/terminalSurfaceAnchor';
import {accessSnapshot,applyAccessStatus} from '../../src/access';
import {getPreferences,savePreferences} from '../../src/preferences';
import '../../src/styles.css';

export type SurfaceCall={command:'place';session:string;anchor:SurfaceAnchor;background:number}|{command:'remove';session:string};
declare global {interface Window {nativeSurface:Awaited<ReturnType<typeof mountNativeSurfaceHarness>>}}

/**
 * One terminal pane in the app's own shell chain (viewport, shell, workspace, session body), on the native adapter over the headless
 * stand-in core or on xterm.js. The shell's surface commands are recorded in `calls`; `refuse` makes `place` answer as a release build does.
 * No host, transport or private terminal content: the output is synthetic.
 */
export async function mountNativeSurfaceHarness({engine,refuse=false,bridge}:{engine:'native'|'xterm';refuse?:boolean;bridge?:NativeCoreBridge}) {
  applyAccessStatus({initialized:true,supported:true,reason:'Synthetic native surface access fixture.',enabled:true,locked:false,
    generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});
  // The workspace beneath stays mounted but unseen, so what the page paints here is only this pane's chain.
  document.getElementById('root')!.style.display='none';
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'100',display:'flex',flexDirection:'column',background:'#101010'});
  const chain=(['div.app-viewport','div.app-shell','main.workspace','div.session-body'] as const).reduce((parent,spec)=>{
    const [tag,className]=spec.split('.'),element=document.createElement(tag);
    element.className=className;parent.append(element);return element;
  },host);
  document.body.append(host);
  const {adapter,core}=await createBrowserTerminal(engine,{columns:40,rows:10},bridge);
  const session:LiveSession={id:'native-surface-fixture',hostId:'fixture',name:'Native surface fixture',destination:'fixture',adapter,connected:true};
  const calls:SurfaceCall[]=[],errors:string[]=[];
  const app=window.nativeFixtureInvoke;
  window.nativeFixtureInvoke=async(command,args={},options)=>{
    if(command==='native_terminal_surface_place'){
      if(refuse)throw 'native_surface_disabled';
      calls.push({command:'place',session:String(args.session),anchor:args.anchor as SurfaceAnchor,background:Number(args.background)});
      return {placed:true,ready:true,generation:1,width:1,height:1};
    }
    if(command==='native_terminal_surface_remove'){calls.push({command:'remove',session:String(args.session)});return;}
    if(command==='resize'||command==='write_stdin')return;
    return app(command,args,options);
  };
  const root=createRoot(chain);
  const render=(active:boolean)=>flushSync(()=>root.render(<TerminalPane session={session} active={active} reportError={error=>errors.push(String(error))}/>));
  render(true);
  return {session,core,calls,errors,chain,
    /** Shows or hides the pane as switching sessions does. */
    setActive:render,
    /** The Option as Meta setting, as the pane hands it to the adapter once it has rendered. */
    async setOptionAsMeta(optionAsMeta:boolean){
      savePreferences({...getPreferences(),optionAsMeta});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    },
    /** Ends the pane while the adapter lives on, as closing its session does. */
    unmount:()=>root.unmount(),
    /** Output from the program, as the transport would deliver it. */
    output:(text:string)=>core?core.output(new TextEncoder().encode(text)):adapter.write!(new TextEncoder().encode(text)),
    dispose(){try{root.unmount();}catch{/* already unmounted */}void adapter.dispose();host.remove();document.getElementById('root')!.style.display='';}};
}
