import type {NativeCoreBridge, NativeCoreEvent, NativeCoreSnapshot} from '../../src/nativeCoreBridge';
import type {} from './stdioBrowserTerminal';

/** Page side of the test-owned process binding. Feed replies include the events emitted while parsing those bytes. */
export function stdioPageCore(recordInput:(text:string)=>void):NativeCoreBridge {
  const listeners=new Set<(event:NativeCoreEvent)=>void>();
  async function request<T>(message:Parameters<Window['fixtureNativeControl']>[0]):Promise<T> {
    const {result,events}=await window.fixtureNativeControl(message);
    for(const event of events) for(const listener of listeners) listener(event);
    return result as T;
  }
  return {
    snapshot:()=>request<NativeCoreSnapshot>({kind:'snapshot'}),
    scroll:action=>request({kind:'scroll',action}),
    feed:bytes=>request({kind:'feed',bytes:Array.from(bytes)}),
    resize:size=>request({kind:'resize',size}),
    setScrollback:lines=>request({kind:'scrollback',lines}),
    query:query=>request({kind:'query',query}),
    async input(data) {
      const text=typeof data==='string'?data:new TextDecoder().decode(data);
      await request({kind:'input',text});
      recordInput(text);
    },
    async key() {throw new Error('The stdio fixture has no key input.');},
    subscribe(listener){listeners.add(listener);return {dispose:()=>{listeners.delete(listener);}};},
    close:()=>request({kind:'close'}),
  };
}
