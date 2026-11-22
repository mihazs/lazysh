import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {androidTerminalCoreAcceptance,validateTerminalCoreReport} from './support/androidTerminalCore';

const nativeCase='theCoreInsideTheAppParsesTheOutputOfARealShellAndReadsItBack';
const composition=['thePageShowsTheSurfaceThroughItsNativePaneWithItsOverlayAboveAndTheWebViewIsOpaqueAgainWhenItEnds','aPlacedSurfaceChangesNothingOnAPageThatIsNotANativePane','aRecreatedActivityStartsOpaqueAndShowsTheSurfaceAgainOnceItsPagePlacesIt'];
const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
const row=(body='',name=nativeCase,className='app.lazysh.client.NativeTerminalCoreTest')=>`<testcase name="${name}" classname="${className}" time="1">${body}</testcase>`;
const compositionRows=()=>composition.map(name=>row('',name,'app.lazysh.client.NativeTerminalCompositionTest'));

test('the terminal core report counts only its cases, each passing exactly once',()=>{
  expect(()=>validateTerminalCoreReport(report([row(),...compositionRows()]))).not.toThrow();
  for(const rows of [[],[row()],compositionRows(),[row(),row(),...compositionRows()],[row(),...compositionRows(),...compositionRows().slice(1)],[row('<skipped/>'),...compositionRows()],
    [row(),...compositionRows().slice(0,2),row('<failure message="x"/>',composition[2],'app.lazysh.client.NativeTerminalCompositionTest')],
    [row('<error message="x"/>'),...compositionRows()],[row('','otherCase'),...compositionRows()],
    [row('',nativeCase,'app.lazysh.client.NativeWorkspaceTest'),...compositionRows()]])
    expect(()=>validateTerminalCoreReport(report(rows))).toThrow('did not pass exactly once');
});

test('the shared Android runtime job leaves the terminal core case to the job that builds the feature and has the fixture',async()=>{
  const moon=Bun.YAML.parse(await readFile(join(import.meta.dir,'../apps/client/moon.yml'),'utf8')) as {tasks:Record<string,{script:string}>};
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalCoreTest');
});

// The case needs the x86_64 debug APK built with the native-terminal feature and an explicitly selected emulator or Waydroid guest.
test.skipIf(process.env.LAZYSH_ANDROID_UI_TERMINAL_CORE!=='1')('actual Android app parses the output of a real shell in its terminal core and reads it back through the IPC',async()=>{
  await androidTerminalCoreAcceptance();
},1_000_000);
