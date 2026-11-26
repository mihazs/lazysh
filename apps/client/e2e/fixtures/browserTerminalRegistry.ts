import type {NativeCoreBridge} from '../../src/nativeCoreBridge';
import {nativeCapabilities,openNativeTerminalAdapter} from '../../src/nativeTerminalAdapter';
import type {TerminalBackendId} from '../../src/terminalAdapter';
import {createBackendRegistry} from '../../src/terminalBackendRegistry';
import {createTerminalAdapter} from '../../src/terminalBackends';
import {createHeadlessCore,type HeadlessCoreOptions} from '../../src/xterm/nativeCoreHeadless';
import {createXtermTerminalAdapter,xtermCapabilities} from '../../src/xtermTerminalAdapter';

export async function createBrowserTerminal(engine:TerminalBackendId,options?:HeadlessCoreOptions,provided?:NativeCoreBridge) {
  const registry=createBackendRegistry();
  registry.register({id:'xterm',capabilities:xtermCapabilities,autoEligible:true,
    probe:()=>({ok:true}),create:createXtermTerminalAdapter});
  const core=engine==='native'&&!provided?createHeadlessCore(options):undefined;
  const bridge=provided??core;
  if(bridge)registry.register({id:'native',capabilities:nativeCapabilities,autoEligible:false,
    probe:()=>({ok:true}),create:()=>openNativeTerminalAdapter(bridge,{refreshMs:1})});
  return {...await createTerminalAdapter({override:engine},registry),core};
}
