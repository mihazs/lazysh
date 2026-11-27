import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeBenchmarkInstrumentationCommand} from '../apps/client/bench/androidNativeBench';
import {androidNativeSessionAcceptance,sessionCases,validateNativeSessionReport} from './support/androidTerminalCore';

const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
const row=([className,name]:readonly [string,string],body='')=>`<testcase name="${name}" classname="${className}" time="1">${body}</testcase>`;

test('the native session report counts its one case passing exactly once',()=>{
  const [only]=sessionCases;
  expect(()=>validateNativeSessionReport(report([row(only)]))).not.toThrow();
  for(const rows of [[],[row(only),row(only)],[row(only,'<skipped/>')],[row(only,'<failure message="x"/>')],[row(only,'<error message="x"/>')],
    [row([only[0],'otherCase'])],[row(['app.lazysh.client.NativeTerminalCoreTest',only[1]])]])
    expect(()=>validateNativeSessionReport(report(rows))).toThrow('did not pass exactly once');
});

test('the shared Android runtime job and the terminal core job leave the native session to the job that builds the feature and runs only it',async()=>{
  const moon=Bun.YAML.parse(await readFile(join(import.meta.dir,'../apps/client/moon.yml'),'utf8')) as {tasks:Record<string,{script:string}>};
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalSessionTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeAcceptanceTest');
});

test('the packaged benchmark selects only its own AndroidJUnitRunner method and reports before teardown',()=>{
  const command=nativeBenchmarkInstrumentationCommand('emulator-5554','/data/local/tmp/fixture.json',4242,true);
  const selection=command.indexOf('class');
  expect(command.slice(selection-1,selection+2)).toEqual([
    '-e','class','app.lazysh.client.NativeTerminalSessionTest#aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart',
  ]);
  const wait=command.indexOf('waitForActivitiesToComplete');
  expect(command.slice(wait-1,wait+2)).toEqual(['-e','waitForActivitiesToComplete','false']);
});

// The case needs the x86_64 debug APK built with the native-terminal feature and an explicitly selected emulator or Waydroid guest.
test.skipIf(process.env.LAZYSH_ANDROID_UI_NATIVE_SESSION!=='1')('actual Android app opens a native session through its real UI, draws the shell on a surface and takes typing',async()=>{
  await androidNativeSessionAcceptance(undefined,process.env.LAZYSH_ANDROID_SOFTWARE_GPU!=='0');
},1_000_000);
