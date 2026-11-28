import type {Page} from '@playwright/test';
import type {NativeCoreBridge, NativeCoreEvent, NativeCoreQuery, NativeCoreSnapshot} from '../../src/nativeCoreBridge';
import type {TerminalScrollAction, TerminalSize} from '../../src/terminalAdapter';
import {openStdioCore} from '../../src/test/stdioNativeCore';

type Request =
  | {kind:'snapshot'|'close'}
  | {kind:'feed';bytes:number[]}
  | {kind:'scroll';action:TerminalScrollAction}
  | {kind:'resize';size:TerminalSize}
  | {kind:'scrollback';lines:number}
  | {kind:'query';query:NativeCoreQuery}
  | {kind:'input';text:string};
type Response = {result?:unknown;events:NativeCoreEvent[]};

declare global { interface Window {fixtureNativeControl:(request:Request)=>Promise<Response>} }

/** One owned runtime process for the page. Only the fixture's typed control operations cross the browser boundary. */
export async function installStdioBrowserTerminal(page:Page,binary:string) {
  const core=await openStdioCore(binary,{columns:80,rows:24});
  const events:NativeCoreEvent[]=[];
  const subscription=core.subscribe(event=>events.push(event));
  page.once('close',()=>{subscription.dispose();void core.close();});
  await page.exposeBinding('fixtureNativeControl',async(_source,request:Request):Promise<Response>=>{
    let result:unknown;
    switch(request.kind) {
      case 'snapshot': result=await core.snapshot();break;
      case 'scroll': result=await core.scroll(request.action);break;
      case 'feed': result=await core.feed!(Uint8Array.from(request.bytes));break;
      case 'resize': result=await core.resize!(request.size);break;
      case 'scrollback': result=await core.setScrollback!(request.lines);break;
      case 'query': result=await core.query!(request.query);break;
      case 'input': await core.input(request.text,'keyboard');break;
      case 'close': await core.close();break;
    }
    return {result,events:events.splice(0)};
  });
}
