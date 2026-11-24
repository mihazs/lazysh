import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {androidNativeSessionAcceptance,sessionCases,validateNativeSessionReport} from './support/androidTerminalCore';

const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
const row=([className,name]:readonly [string,string],body='')=>`<testcase name="${name}" classname="${className}" time="1">${body}</testcase>`;

test('the native session report counts each of its cases passing exactly once',()=>{
  const [first,...others]=sessionCases;
  expect(()=>validateNativeSessionReport(report(sessionCases.map(found=>row(found))))).not.toThrow();
  for(const rows of [[],[row(first),row(first),...others.map(found=>row(found))],[row(first,'<skipped/>'),...others.map(found=>row(found))],[row(first,'<failure message="x"/>'),...others.map(found=>row(found))],
    [row(first,'<error message="x"/>'),...others.map(found=>row(found))],[row([first[0],'otherCase']),...others.map(found=>row(found))],
    [row(['app.lazysh.client.NativeTerminalCoreTest',first[1]]),...others.map(found=>row(found))],
    // A run that kept only one of the classes (a filter) is no pass.
    ...sessionCases.map(kept=>[row(kept)])])
    expect(()=>validateNativeSessionReport(report(rows))).toThrow('did not pass exactly once');
});

test('the shared Android runtime job and the terminal core job leave the native session to the job that builds the feature and runs only it',async()=>{
  const moon=Bun.YAML.parse(await readFile(join(import.meta.dir,'../apps/client/moon.yml'),'utf8')) as {tasks:Record<string,{script:string}>};
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalSessionTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalGesturesTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalTmuxPagesTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeAcceptanceTest');
});

// The case needs the x86_64 debug APK built with the native-terminal feature and an explicitly selected emulator or Waydroid guest.
test.skipIf(process.env.LAZYSH_ANDROID_UI_NATIVE_SESSION!=='1')('actual Android app opens a native session through its real UI, draws the shell on a surface and takes typing',async()=>{
  await androidNativeSessionAcceptance(undefined,process.env.LAZYSH_ANDROID_SOFTWARE_GPU!=='0');
},1_000_000);
