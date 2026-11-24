import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {androidNativeSessionAcceptance,sessionRuns,validateNativeSessionReport} from './support/androidTerminalCore';

const report=(rows:string[])=>`<?xml version="1.0"?><testsuites><testsuite tests="${rows.length}">${rows.join('')}</testsuite></testsuites>`;
const row=([className,name]:readonly [string,string],body='')=>`<testcase name="${name}" classname="${className}" time="1">${body}</testcase>`;

test('each native session run counts its case passing exactly once',()=>{
  for(const run of sessionRuns) {
    const [first]=run.cases;
    expect(()=>validateNativeSessionReport(report(run.cases.map(found=>row(found))),run)).not.toThrow();
    for(const rows of [[],[row(first),row(first)],[row(first,'<skipped/>')],[row(first,'<failure message="x"/>')],[row(first,'<error message="x"/>')],
      [row([first[0],'otherCase'])],[row(['app.lazysh.client.NativeTerminalCoreTest',first[1]])],
      // Another run's case in this run's report is no pass.
      ...sessionRuns.filter(other=>other!==run).map(other=>[row(other.cases[0])])])
      expect(()=>validateNativeSessionReport(report(rows),run)).toThrow('did not pass exactly once');
  }
});

test('no two native session runs share a class, an evidence directory or an evidence file',()=>{
  const unique=(values:string[])=>expect(new Set(values).size).toBe(values.length);
  unique(sessionRuns.flatMap(run=>run.classes));
  unique(sessionRuns.map(run=>run.evidenceName));
  unique(sessionRuns.flatMap(run=>run.evidence));
});

test('the shared Android runtime job and the terminal core job leave the native session to the job that builds the feature and runs only it',async()=>{
  const moon=Bun.YAML.parse(await readFile(join(import.meta.dir,'../apps/client/moon.yml'),'utf8')) as {tasks:Record<string,{script:string}>};
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalSessionTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalGesturesTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalTmuxPagesTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalZellijPagesTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeTerminalRmuxPagesTest');
  expect(moon.tasks['test-android'].script.match(/notClass=(\S+)/)![1].split(',')).toContain('app.lazysh.client.NativeAcceptanceTest');
});

// The case needs the x86_64 debug APK built with the native-terminal feature and an explicitly selected emulator or Waydroid guest.
test.skipIf(process.env.LAZYSH_ANDROID_UI_NATIVE_SESSION!=='1')('actual Android app opens a native session through its real UI, draws the shell on a surface and takes typing',async()=>{
  await androidNativeSessionAcceptance(undefined,process.env.LAZYSH_ANDROID_SOFTWARE_GPU!=='0');
},1_000_000);
