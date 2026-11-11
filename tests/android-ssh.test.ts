import {expect,test,spyOn} from 'bun:test';
import {chmod,link,lstat,mkdir,mkdtemp,readFile,rename,rm,symlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import * as childProcess from 'node:child_process';
import * as fileSystem from 'node:fs/promises';
import * as ownedProcesses from './support/ownedProcess';
import {reportOwnedTeardownFailure} from './support/ownedProcess';
import {reportOwnedSshPromptFailure,receiverProbeErrors} from './support/sshFixture';
import type {HerdrFixture} from './support/androidHerdr';
import {observeAndroidMoshBackground} from './support/androidMoshBackground';
import {OwnedCaseCrashParser} from './support/androidCaseCrash';
import {SshFixture,OwnedProcess,identity,checkRawReceiverIdentity,packageExitInfo,androidSshCleanup,emulatorContinuity,compareEmulatorContinuity,hostAdbServerIdentity,compareHostAdbServer,gradleFailureClasses,instrumentationFailures,reportInstrumentationFailures,captureOwnedCaseCrashes,recoverOwnedCaseCrash,ownedAndroidPackagePresence,androidSshAcceptance,ownedSoftwareKeyboard,attachmentReceipt,attachmentIdentity,verifyImeReceiverBytes,IME_TRANSACTION_WIRE,readRawReceiverBytes,observeImeReceiverWire,dpadReceipt,verifyDpadReceiverBytes,validateSharedHerdrReport,validateRecordedConversationReport,sharedHerdrReportIdentity,verifySharedHerdrResult} from './support/androidSsh';

test('owned process failures never include captured output or arguments',async()=>{
  const owned=new OwnedProcess(process.execPath,['-e',"process.stderr.write('private-fixture-secret');process.exit(31)"]);
  const error=await owned.finish('synthetic failure',1000).catch(error=>error as Error);
  expect((error as Error).message).toBe('Owned fixture failed: synthetic failure; exit=31');
  expect(await owned.startupDiagnostic()).toEqual({state:'early-exit',exitCode:31});
});

test.skipIf(process.platform!=='linux').each(['missing','denied'] as const)('owned startup distinguishes %s launcher without exposing paths or arguments',async failure=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-process-admission-'));
  const executable=join(directory,'private-launcher');
  if(failure==='denied')await writeFile(executable,'#!/bin/sh\necho private-output\n',{mode:0o600});
  const child=new OwnedProcess(executable,['private-argument']);
  const completion=child.done.catch(error=>error as Error);
  try {
    expect(await child.liveIdentity()).toBeUndefined();
    expect(await child.startupDiagnostic()).toEqual({state:failure==='missing'?'missing-launcher':'launch-denied',exitCode:null});
    expect(child.child.pid).toBeUndefined();
    expect((await completion as Error).message).toBe('Owned fixture process could not start');
  } finally {await child.stop().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});

test.skipIf(process.platform!=='linux')('owned startup separates live process metadata from subsequent signaled exit',async()=>{
  const child=new OwnedProcess('sleep',['120']);
  try {
    expect(await child.liveIdentity()).toBeDefined();
    expect(await child.startupDiagnostic()).toEqual({state:'running',exitCode:null});
    expect(await child.teardownDiagnostic()).toMatchObject({scope:'post-stop-sample',originalAvailable:true,currentIdentity:'matching-live',leaderExitObserved:false,closeObserved:false});
    await child.stop();
    expect(await child.startupDiagnostic()).toEqual({state:'signaled',exitCode:null});
    expect(await child.teardownDiagnostic()).toMatchObject({scope:'post-stop-sample',leaderExitObserved:true,closeObserved:true,streams:{stdin:{destroyed:true},stdout:{destroyed:true},stderr:{destroyed:true}}});
  } finally {await child.stop();}
});

test.skipIf(process.platform!=='linux')('SSH startup retains its closed missing-launcher diagnostic without an unhandled rejection',async()=>{
  const original=childProcess.spawn;
  const spawn=spyOn(childProcess,'spawn').mockImplementation((program,args,options)=>
    original(program==='/usr/bin/bwrap'?'/nonexistent-private-fixture-launcher':program,args,options));
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    await expect(SshFixture.start(undefined,{privateTtyGroup:true})).rejects.toThrow(
      'Owned SSH root identity unavailable; startup={"state":"missing-launcher","exitCode":null}');
  } finally {spawn.mockRestore();warning.mockRestore();}
});
test.skipIf(process.platform!=='linux')('owned deadline stops its process group',async()=>{
  const child=new OwnedProcess('sleep',['120']);
  const pid=child.child.pid!;
  await expect(child.finish('synthetic timeout',30)).rejects.toThrow('Owned fixture deadline: synthetic timeout');
  expect(()=>process.kill(pid,0)).toThrow();
});

test.skipIf(process.platform!=='linux')('background escape is unsupported and never reported as proven clean',async()=>{
  const child=new OwnedProcess('sh',['-c','sleep 120 & printf "%s\\n" "$!"; exit 0']);
  let pid=0;
  let originalStart='';
  const start=async()=>{
      try {const stat=await readFile(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19];}
      catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return '';throw error;}
    };
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  const pending=child.finish('unsupported background escape',50).catch(error=>error as Error);
  try {
    const deadline=performance.now()+1000;
    while(!pid) {
      const value=child.stdout.trim();
      if(/^[0-9]+$/.test(value))pid=Number(value);
      else {expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(5);}
    }
    originalStart=await start();
    expect(originalStart.length).toBeGreaterThan(0);
    if(child.child.exitCode===null)await new Promise<void>(resolve=>{child.child.once('exit',()=>resolve());});
    expect(await child.teardownDiagnostic()).toMatchObject({scope:'post-stop-sample',leaderExitObserved:true,closeObserved:false,streams:{stdout:{closed:false,destroyed:false}}});
    expect((await pending as Error).message).toBe('Owned fixture deadline: unsupported background escape');
    expect(warning).toHaveBeenCalledWith('Owned fixture cleanup failed after original failure');
    // This negative fixture, not the foreground helper, owns the still-live child.
    expect(await start()).toBe(originalStart);
  } finally {
    if(pid && originalStart) {
      if(await start()===originalStart) {
        try{process.kill(pid,'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      }
      const retired=performance.now()+1000;
      while(await start()===originalStart && performance.now()<retired)await Bun.sleep(10);
      expect(await start()).not.toBe(originalStart);
    }
    warning.mockRestore();await child.stop();
  }
},5000);

test('teardown reporter whitelists closed fields and cannot throw over a primary failure',async()=>{
  const child=new OwnedProcess(process.execPath,['-e','process.exit(0)']);
  await child.finish('owned observation fixture',1000);
  const secret='private-pid-path-argv-output-error';
  const lines:string[]=[];
  const warning=spyOn(console,'error').mockImplementation(value=>{lines.push(String(value));});
  const diagnostic=spyOn(child,'teardownDiagnostic');
  try {
    diagnostic.mockResolvedValue({scope:secret,originalAvailable:secret,currentIdentity:secret,leaderExitObserved:secret,closeObserved:secret,
      streams:{stdin:{closed:secret,destroyed:secret,private:secret},stdout:{},stderr:null},private:secret} as unknown as Awaited<ReturnType<OwnedProcess['teardownDiagnostic']>>);
    for(const stage of ['attach-stop','herdr-stop','ssh-stop'] as const)await reportOwnedTeardownFailure(child,stage);
    expect(lines).toHaveLength(3);
    for(const [index,line] of lines.entries()) {
      expect(line).not.toContain(secret);
      expect(JSON.parse(line.slice('Owned teardown observation '.length))).toEqual({stage:['attach-stop','herdr-stop','ssh-stop'][index],observation:{scope:'post-stop-sample',originalAvailable:null,currentIdentity:'unavailable',leaderExitObserved:null,closeObserved:null,
        streams:{stdin:{closed:null,destroyed:null},stdout:{closed:null,destroyed:null},stderr:{closed:null,destroyed:null}}}});
    }
    await reportOwnedTeardownFailure(child,secret as 'attach-stop');
    expect(lines).toHaveLength(3);
    diagnostic.mockRejectedValue(new Error(secret));
    await reportOwnedTeardownFailure(child,'attach-stop');
    expect(lines.at(-1)).toBe('Owned teardown observation '+JSON.stringify({stage:'attach-stop',observation:{scope:'post-stop-sample',state:'unavailable'}}));
    warning.mockImplementation(()=>{throw new Error(secret);});
    await expect(reportOwnedTeardownFailure(child,'attach-stop')).resolves.toBeUndefined();
  } finally {diagnostic.mockRestore();warning.mockRestore();await child.stop();}
});

test.each(['attach','fixture'] as const)('actual Herdr host %s cleanup block preserves body and cleanup error identities',async(stage)=>{
  const source=await readFile(join(import.meta.dir,'android-ssh-host.test.ts'),'utf8');
  const host=source.slice(source.indexOf('  const owned=await HerdrFixture.start(herdrTools(),mosh?'));
  const start=host.indexOf(stage==='attach'?'    } catch(error){attachPrimary=true;throw error;}':'  } catch(error){primary=true;throw error;}');
  const end=host.indexOf(stage==='attach'?"    expect(await owned.history()).toMatchObject({offset:8":'  expect(await listening(owned.ssh.port))',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const block=host.slice(start,end),flag=stage==='attach'?'attachPrimary':'primary';
  const execute=new Function('body','client','owned','reportOwnedTeardownFailure',`return (async()=>{let ${flag}=false;try{await body();\n${block}})()`);
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    for(const bodyFails of [false,true])for(const cleanupFails of [false,true]) {
      const original=new Error('private-body-failure'),cleanup=new Error('private-cleanup-failure'),calls:string[]=[];
      const owner={stop:async()=>{calls.push('stop');if(cleanupFails)throw cleanup;}};
      const result=await execute(async()=>{calls.push('body');if(bodyFails)throw original;},owner,owner,reportOwnedTeardownFailure).catch((error:unknown)=>error);
      expect(result).toBe(bodyFails?original:cleanupFails?cleanup:undefined);
      expect(calls).toEqual(['body','stop']);
    }
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-');
  } finally {warning.mockRestore();}
});

const exitFixture=`ApplicationExitInfo #0:
  timestamp=2026-10-27 22:19:33.701 pid=3389 realUid=10155 packageUid=10155 definingUid=10155 user=0
  process=app.lazysh.client reason=5 (APP CRASH(NATIVE)) subreason=0 (UNKNOWN) status=6
  importance=100 pss=1MB rss=2MB description=private-secret state=private-state trace=/private/path
ApplicationExitInfo #1:
  timestamp=2026-10-27 22:19:20.001 pid=123 realUid=1 packageUid=1 definingUid=1 user=0
  process=other.app reason=1 (EXIT_SELF) subreason=0 (UNKNOWN) status=31
`;

async function withDiagnosticAdb(body:string,code:number,run:(adb:string,args:string,fixture:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'lazysh-exit-info-'));
  const fixture=join(directory,'exit-info');
  const args=join(directory,'args');
  const adb=join(directory,'adb');
  const keys=['EXIT_INFO_FIXTURE','EXIT_INFO_ARGS','EXIT_INFO_CODE'] as const;
  const previous=keys.map(key=>process.env[key]);
  try {
    await writeFile(fixture,body);
    await writeFile(adb,`#!/bin/sh
printf '%s\\n' "$*" >> "$EXIT_INFO_ARGS"
case "$3 $4" in
  'get-state ') sed -n '1p' "$EXIT_INFO_FIXTURE" ;;
  'shell pidof') if [ "$5" = adbd ]; then sed -n '6p' "$EXIT_INFO_FIXTURE"; else sed -n '2p' "$EXIT_INFO_FIXTURE"; fi ;;
  'reverse --list') sed -n '3p' "$EXIT_INFO_FIXTURE" ;;
  'transport-id ') sed -n '4p' "$EXIT_INFO_FIXTURE" ;;
  'shell cat') if [ "$5" = /proc/sys/kernel/random/boot_id ]; then sed -n '5p' "$EXIT_INFO_FIXTURE"; else sed -n '7p' "$EXIT_INFO_FIXTURE"; fi ;;
  *) cat "$EXIT_INFO_FIXTURE" ;;
esac
exit "$EXIT_INFO_CODE"
`);
    await chmod(adb,0o700);
    process.env.EXIT_INFO_FIXTURE=fixture;process.env.EXIT_INFO_ARGS=args;process.env.EXIT_INFO_CODE=String(code);
    await run(adb,args,fixture);
  } finally {
    keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});
    await rm(directory,{recursive:true,force:true});
  }
}

test.each([
  {body:exitFixture,code:0,state:'available',count:1},
  {body:exitFixture.repeat(10),code:0,state:'available',count:8},
  {body:'x'.repeat(2000)+exitFixture,code:0,state:'empty'},
  {body:exitFixture.replace('process=app.lazysh.client','process=other.app')+'  process=app.lazysh.client reason=5 (APP CRASH(NATIVE)) subreason=0 (UNKNOWN) status=6\n',code:0,state:'empty'},
  {body:exitFixture.split('\n').slice(1,3).join('\n'),code:0,state:'empty'},
  {body:exitFixture+exitFixture.split('\n').slice(1,3).join('\n'),code:0,state:'available',count:1},
  {body:'private-secret\nprocess=app.lazysh.client reason=5 (APP CRASH(NATIVE)) subreason=0 (UNKNOWN) status=6\n',code:0,state:'empty'},
  {body:exitFixture+'private-secret'.repeat(6000),code:0,state:'overflow'},
  {body:exitFixture,code:31,state:'unavailable'},
])('owned package exit diagnostics redact native output: $state',async({body,code,state,count})=>{
  await withDiagnosticAdb(body,code,async(adb,args)=>{
    const result=await packageExitInfo(adb,'emulator-5580');
    expect(await readFile(args,'utf8')).toBe('-s emulator-5580 shell dumpsys activity exit-info app.lazysh.client\n');
    expect(result.state).toBe(state);
    expect(result.shape.serviceHeader).toBe(false);
    for(const count of [result.shape.recordHeaders,result.shape.timestampRows,result.shape.ownedProcessRows])expect(count).toBeLessThanOrEqual(256);
    expect(result.records).toEqual(state==='available'?Array.from({length:count!},()=>({timestamp:'2026-10-27 22:19:33.701',pid:3389,reason:5,subreason:0,status:6})):[]);
    const rendered=JSON.stringify(result);
    for(const secret of ['private-secret','private-state','/private/path','other.app','realUid','description','trace'])expect(rendered).not.toContain(secret);
  });
});

test.each([true,false])('owned Android cleanup retains primary failure and only finite stages: primary=$0',async(primary)=>{
  const original=new Error('original instrumentation failure');
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  const calls:string[]=[];
  try {
    const failure=await (async()=>{
      try {if(primary)throw original;}
      finally {await androidSshCleanup(primary,[
        ['reverse',async()=>{calls.push('reverse');throw new Error('private-cleanup-secret');}],
        ['fixture-file',async()=>{calls.push('fixture-file');}],
        ['Herdr',async()=>{calls.push('Herdr');throw new Error('private-payload');}],
      ]);}
    })().catch(error=>error);
    expect(primary?failure===original:failure.message==='Owned Android SSH cleanup failed').toBe(true);
    expect(calls).toEqual(['reverse','fixture-file','Herdr']);
    expect(warning.mock.calls).toEqual([
      ['Owned Android SSH cleanup stage failed: reverse'],
      ['Owned Android SSH cleanup stage failed: Herdr'],
      ...(primary?[['Owned Android SSH cleanup failed after original failure']]:[]),
    ]);
  } finally {warning.mockRestore();}
});

test('diagnostic child mode does not retain raw stdout or stderr',async()=>{
  const owned=new OwnedProcess(process.execPath,['-e',"process.stdout.write('private-output');process.stderr.write('private-error')"],undefined,process.env,false);
  expect(await owned.finish('redacted diagnostic child',1000)).toBe('');
  expect(owned.stdout).toBe('');expect(owned.stderr).toBe('');
});

test('exit shape distinguishes a recognized empty service from unrecognized output',async()=>{
  await withDiagnosticAdb('ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)\nLast Timestamp of Persistence Into Persistent Storage: 2026-10-27 22:00:00.000\n',0,async(adb)=>{
    expect(await packageExitInfo(adb,'emulator-5580')).toEqual({state:'empty',shape:{serviceHeader:true,recordHeaders:0,timestampRows:0,ownedProcessRows:0},records:[]});
  });
});

test.each([
  {body:'device\n3438\nhost tcp:46867 tcp:45678\n',code:0,connection:'device',process:'present',mainPids:[3438],reverse:'present'},
  {body:'offline\n3438 3439\nemulator-5580 tcp:46867 tcp:45678\n',code:0,connection:'offline',process:'present',mainPids:[3438,3439],reverse:'present'},
  {body:'private-secret\n3438 private-pid\nhost tcp:46867 tcp:9999\n',code:0,connection:'unrecognized',process:'unrecognized',mainPids:[],reverse:'missing'},
  {body:'device\n3438\nhost tcp:46866 tcp:45678\n',code:0,connection:'device',process:'present',mainPids:[3438],reverse:'missing'},
  {body:'device\n3438\nhost tcp:46867 tcp:45678\n',code:31,connection:'unavailable',process:'unavailable',mainPids:[],reverse:'unavailable'},
  {body:'x'.repeat(5000)+'\n'+'1 '.repeat(3000)+'\n'+'x'.repeat(5000),code:0,connection:'overflow',process:'overflow',mainPids:[],reverse:'overflow'},
])('owned-emulator continuity retains only bounded fields: $connection/$reverse',async({body,code,...expected})=>{
  await withDiagnosticAdb(body,code,async(adb,args)=>{
    const summary=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    const state=code!==0?'unavailable':'unrecognized';
    expect(summary).toEqual({...expected,transport:state,transportHash:null,boot:state,bootHash:null,adbd:state,adbdHash:null});
    expect((await readFile(args,'utf8')).trim().split('\n').sort()).toEqual([
      '-s emulator-5580 get-state','-s emulator-5580 shell pidof app.lazysh.client','-s emulator-5580 reverse --list',
      '-s emulator-5580 transport-id','-s emulator-5580 shell cat /proc/sys/kernel/random/boot_id','-s emulator-5580 shell pidof adbd',
    ].sort());
    expect(JSON.stringify(summary)).not.toContain('private-');
  });
});

test.each([
  {body:'package:app.lazysh.client\npackage:app.lazysh.client.test\npackage:app.lazysh.client.other\n',code:0,application:'present',instrumentation:'present'},
  {body:'package:app.lazysh.client.other\n',code:0,application:'absent',instrumentation:'absent'},
  {body:'',code:0,application:'absent',instrumentation:'absent'},
  {body:'private-secret',code:0,application:'unrecognized',instrumentation:'unrecognized'},
  {body:'private-secret'.repeat(500),code:0,application:'overflow',instrumentation:'overflow'},
  {body:'package:app.lazysh.client',code:31,application:'unavailable',instrumentation:'unavailable'},
])('owned package presence retains exact fixed IDs only: $application/$instrumentation',async({body,code,application,instrumentation})=>{
  await withDiagnosticAdb(body,code,async(adb,args)=>{
    const result=await ownedAndroidPackagePresence(adb,'emulator-5580');
    expect(result).toEqual({application,instrumentation});
    expect(await readFile(args,'utf8')).toBe('-s emulator-5580 shell pm list packages app.lazysh.client\n');
    expect(JSON.stringify(result)).not.toMatch(/private-secret|app[.]lazysh|package:/);
  });
});

test.each(['gradle','reverse','keyboard']).skipIf(process.platform!=='linux')('explicit reverse ownership preserves the original failure: %s',async failure=>{
  const rejected=failure==='reverse';
  await withDiagnosticAdb('45001\n',0,async(adb,args)=>{
    const directory=dirname(adb),sdk=join(directory,'sdk'),root=join(directory,'checkout');
    const android=join(root,'apps/client/src-tauri/gen/android');
    await mkdir(join(sdk,'platform-tools'),{recursive:true});await mkdir(android,{recursive:true});
    await writeFile(join(sdk,'platform-tools/adb'),(await readFile(adb,'utf8')).replace('case \"$3 $4\" in', 'case \"$3 $4\" in\n'+(rejected?"  'reverse --no-rebind') exit 31 ;;\n":'')+"  'shell settings') if [ \"$7\" = default_input_method ]; then printf '"+(failure==='keyboard'?'private-keyboard-secret':latinIme)+"\\n'; else printf '1\\n'; fi; exit 0 ;;\n  'shell ime') printf 'com.android.inputmethod.latin/.LatinIME\\n'; exit 0 ;;\n  'uninstall app.lazysh.client.test'|'uninstall app.lazysh.client') exit 31 ;;"));
    await chmod(join(sdk,'platform-tools/adb'),0o700);
    const gradleArgs=join(directory,'gradle-args');
    await writeFile(join(android,'gradlew'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(gradleArgs)},JSON.stringify(process.argv.slice(2)));process.exit(31);\n`);
    await chmod(join(android,'gradlew'),0o700);
    const previousHome=process.env.ANDROID_HOME,previousSerial=process.env.ANDROID_SERIAL,previousSocket=process.env.ADB_SERVER_SOCKET;
    const warning=spyOn(console,'error').mockImplementation(()=>{});
    process.env.ANDROID_HOME=sdk;process.env.ANDROID_SERIAL='emulator-5580';
    process.env.ADB_SERVER_SOCKET='unsupported-owned-test-endpoint';
    let stopped=false;
    // Synthetic harness input; this test does not claim actual SSH, APK or WebView execution.
    const fixture={ssh:{directory,nonce:'a'.repeat(32),port:45678,username:'owned',privateKey:'private-fixture-key',fingerprint:'owned',prompt:'owned',challenge:'owned',expected:'owned'},
      metadata:()=>({name:'owned'}),historyDiagnostic:async()=>{throw new Error('private-diagnostic-error');},stop:async()=>{stopped=true;throw new Error('private-cleanup-error');}} as unknown as HerdrFixture;
    try {
      await expect(androidSshAcceptance(root,fixture)).rejects.toThrow(failure==='keyboard'?'Owned software keyboard requires the image AOSP LatinIME':`Owned fixture failed: ${rejected?'owned emulator command':'actual Android SSH UI instrumentation'}; exit=31`);
      const calls=(await readFile(args,'utf8')).trim().split('\n');
      expect(calls[0]).toBe('-s emulator-5580 reverse --no-rebind tcp:45678 tcp:45678');
      expect(calls.some(call=>call.includes('tcp:0'))).toBe(false);
      expect(stopped).toBe(true);
      if(rejected || failure==='keyboard') {
        expect(calls.some(call=>call.includes('shell mkdir')||call.includes(' push '))).toBe(false);
        expect(calls.filter(call=>call.includes('reverse --remove'))).toEqual(rejected?[]:['-s emulator-5580 reverse --remove tcp:45678']);
        await expect(readFile(gradleArgs,'utf8')).rejects.toMatchObject({code:'ENOENT'});
        await expect(readFile(join(directory,'android-fixture.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
        if(failure==='keyboard') {
          const unavailable=JSON.parse(await readFile(join(android,'app/build/outputs/androidTest-results/herdr-ui/package-exit.json'),'utf8'));
          expect(unavailable.softwareKeyboard).toEqual({state:'unavailable'});
          expect(JSON.stringify(unavailable)).not.toContain('private-keyboard-secret');
        }
        expect(warning.mock.calls).toContainEqual(['Owned Android SSH cleanup stage failed: Herdr']);
        return;
      }
      expect(JSON.parse(await readFile(join(directory,'android-fixture.json'),'utf8')).port).toBe(45678);
      expect(calls.filter(call=>call.includes('reverse --remove'))).toEqual(['-s emulator-5580 reverse --remove tcp:45678']);
      const passed=JSON.parse(await readFile(gradleArgs,'utf8')) as string[];
      expect(passed).toContain('-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true');
      expect(passed).toContain('-PlazyshHerdrAcceptance=true');
      const probe=calls.indexOf('-s emulator-5580 shell dumpsys activity exit-info app.lazysh.client');
      const packages=calls.indexOf('-s emulator-5580 shell pm list packages app.lazysh.client');
      const testCleanup=calls.indexOf('-s emulator-5580 uninstall app.lazysh.client.test');
      const appCleanup=calls.indexOf('-s emulator-5580 uninstall app.lazysh.client');
      const diagnostics=JSON.parse(await readFile(join(android,'app/build/outputs/androidTest-results/herdr-ui/package-exit.json'),'utf8'));
      expect(diagnostics.softwareKeyboard).toEqual({ime:'aosp-latin',previous:'enabled',requested:'enabled'});
      expect(diagnostics.persistedCrash).toEqual({scope:'persisted-crash-buffer-sample',state:'ineligible',exceptions:[]});
      expect(diagnostics.hostAdbServer).toEqual({before:{state:'inconclusive',hash:null,reason:'unsupported-endpoint'},after:{state:'inconclusive',hash:null,reason:'unsupported-endpoint'},comparison:'unknown'});
      expect(calls.some(call=>call.includes('logcat -b crash -d'))).toBe(false);
      expect(probe).toBeGreaterThanOrEqual(0);expect(packages).toBeGreaterThanOrEqual(0);
      expect(testCleanup).toBeGreaterThan(Math.max(probe,packages));expect(appCleanup).toBeGreaterThan(testCleanup);
      expect(stopped).toBe(true);
      for(const stage of ['test-package','app-package','Herdr'])expect(warning.mock.calls).toContainEqual([`Owned Android SSH cleanup stage failed: ${stage}`]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-cleanup-error');
    } finally {
      warning.mockRestore();
      if(previousHome===undefined)delete process.env.ANDROID_HOME;else process.env.ANDROID_HOME=previousHome;
      if(previousSerial===undefined)delete process.env.ANDROID_SERIAL;else process.env.ANDROID_SERIAL=previousSerial;
      if(previousSocket===undefined)delete process.env.ADB_SERVER_SOCKET;else process.env.ADB_SERVER_SOCKET=previousSocket;
    }
  });
},5000);

const latinIme='com.android.inputmethod.latin/.LatinIME';
const googleIme='com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME';
async function withKeyboardAdb(options:{previous:string;failure?:string;ime?:string;installed?:string;sdk?:string;model?:string;systemGoogle?:string},run:(adb:string,state:()=>Promise<string>,calls:()=>Promise<string[][]>,pid:()=>Promise<number>)=>Promise<void>) {
  await withDiagnosticAdb(options.previous,0,async(adb,args,fixture)=>{
    await writeFile(adb,`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),state=process.env.EXIT_INFO_FIXTURE,options=${JSON.stringify(options)};
fs.appendFileSync(process.env.EXIT_INFO_ARGS,JSON.stringify(a)+'\\n');process.stderr.write('private-keyboard-secret');
const command=a.slice(2).join(' '),key='show_ime_with_hard_keyboard',latin=${JSON.stringify(latinIme)};
const hang=()=>{fs.writeFileSync(state+'.pid',String(process.pid));setInterval(()=>{},1000);};
if(command==='shell settings get secure default_input_method') {
  if(options.failure==='read-timeout')hang();else process.stdout.write(options.ime??latin);
} else if(command==='shell ime list -s')process.stdout.write(options.installed??latin);
else if(command==='shell getprop ro.build.version.sdk') {
  if(options.failure==='image-timeout')hang();else process.stdout.write(options.sdk??'36');
} else if(command==='shell getprop ro.product.model')process.stdout.write(options.model??'sdk_gphone64_x86_64');
else if(command==='shell pm list packages -s com.google.android.inputmethod.latin')process.stdout.write(options.systemGoogle??'package:com.google.android.inputmethod.latin');
else if(command==='shell settings get secure '+key) {
  const value=fs.readFileSync(state,'utf8');
  if(options.failure==='readback' && value==='1' && !fs.existsSync(state+'.gate')){fs.writeFileSync(state+'.gate','');process.stdout.write('private-keyboard-secret');}
  else process.stdout.write(value);
} else {
  const enabling=command==='shell settings put secure '+key+' 1';
  if(enabling && options.failure==='enable-unapplied')process.exit(31);
  if(!enabling && ['restore-failed','enable-and-restore'].includes(options.failure))process.exit(31);
  fs.writeFileSync(state,command==='shell settings delete secure '+key?'null':a.at(-1));
  if(enabling && options.failure==='enable-timeout')hang();
  else if(options.failure===(enabling?'enable-applied':'restore-applied') || (enabling && options.failure==='enable-and-restore'))process.exit(31);
}
`);
    await run(adb,()=>readFile(fixture,'utf8'),async()=>{
      try{return (await readFile(args,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    },async()=>Number(await readFile(fixture+'.pid','utf8')));
  });
}

test.each(['0','1','null']).skipIf(process.platform!=='linux')('owned software keyboard verifies and restores original preference %s',async previous=>{
  await withKeyboardAdb({previous},async(adb,state,calls)=>{
    const owner=await ownedSoftwareKeyboard(adb,'emulator-5580');
    expect(await state()).toBe('1');
    expect(owner.observation).toEqual({ime:'aosp-latin',previous:previous==='0'?'disabled':previous==='1'?'enabled':'unset',requested:'enabled'});
    expect(JSON.stringify(owner.observation)).not.toContain('com.android');
    await owner.restore();const count=(await calls()).length;await owner.restore();
    expect(await state()).toBe(previous);expect((await calls()).length).toBe(count);
    expect((await calls()).every(args=>args[0]==='-s' && args[1]==='emulator-5580')).toBe(true);
    const writes=(await calls()).filter(args=>args[4]==='put'||args[4]==='delete');
    expect(writes.map(args=>args.slice(2))).toEqual(previous==='1'?[]:[['shell','settings','put','secure','show_ime_with_hard_keyboard','1'],['shell','settings',previous==='null'?'delete':'put','secure','show_ime_with_hard_keyboard',...(previous==='null'?[]:[previous])]]);
  });
});
test.each([{previous:'private-keyboard-secret'},{previous:'0',ime:'private-keyboard-secret'},{previous:'0',installed:'private-keyboard-secret'},{previous:'0',installed:'private-keyboard-secret'.repeat(1024)}]).skipIf(process.platform!=='linux')('software keyboard rejects unsupported admission without mutation %#',async options=>{
  await withKeyboardAdb(options,async(adb,state,calls)=>{
    const failure=await ownedSoftwareKeyboard(adb,'emulator-5580').catch(error=>error);
    expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private-keyboard-secret');
    expect(await state()).toBe(options.previous);
    expect((await calls()).some(args=>args[4]==='put'||args[4]==='delete')).toBe(false);
    const count=(await calls()).length;
    await expect(ownedSoftwareKeyboard(adb,'personal-device')).rejects.toThrow('explicit emulator');
    expect((await calls()).length).toBe(count);
  });
});
test.skipIf(process.platform!=='linux')('Google image keyboard needs explicit profile and restores the original preference',async()=>{
  await withKeyboardAdb({previous:'0',ime:googleIme,installed:googleIme},async(adb,state)=>{
    await expect(ownedSoftwareKeyboard(adb,'emulator-5580')).rejects.toThrow('AOSP LatinIME');
    const owner=await ownedSoftwareKeyboard(adb,'emulator-5580',5000,'google-api36-latin');
    expect(owner.observation).toEqual({ime:'google-api36-latin',previous:'disabled',requested:'enabled'});
    expect(await state()).toBe('1');await owner.restore();expect(await state()).toBe('0');
  });
});
test.each([{ime:latinIme},{installed:latinIme},{sdk:'35'},{model:'unowned-model'},{systemGoogle:'package:other.keyboard'}]).skipIf(process.platform!=='linux')('Google keyboard rejects mismatched image identity before mutation %#',async mismatch=>{
  await withKeyboardAdb({previous:'0',ime:googleIme,installed:googleIme,...mismatch},async(adb,state,calls)=>{
    await expect(ownedSoftwareKeyboard(adb,'emulator-5580',5000,'google-api36-latin')).rejects.toThrow('Owned software keyboard');
    expect(await state()).toBe('0');expect((await calls()).some(args=>args[4]==='put'||args[4]==='delete')).toBe(false);
  });
});
test.skipIf(process.platform!=='linux')('Google image admission timeout retires its child without changing preference',async()=>{
  await withKeyboardAdb({previous:'0',ime:googleIme,installed:googleIme,failure:'image-timeout'},async(adb,state,calls,pid)=>{
    await expect(ownedSoftwareKeyboard(adb,'emulator-5580',500,'google-api36-latin')).rejects.toThrow('unavailable: Google image SDK');
    const ownedPid=await pid();expect(()=>process.kill(ownedPid,0)).toThrow();
    expect(await state()).toBe('0');expect((await calls()).some(args=>args[4]==='put'||args[4]==='delete')).toBe(false);
  });
});
test.skipIf(process.platform!=='linux')('unknown keyboard profile is rejected before a device command',async()=>{
  await withKeyboardAdb({previous:'0'},async(adb,state,calls)=>{
    await expect(ownedSoftwareKeyboard(adb,'emulator-5580',5000,'unknown' as never)).rejects.toThrow('profile is unsupported');
    expect(await calls()).toEqual([]);expect(await state()).toBe('0');
  });
});
test.each(['enable-applied','enable-unapplied','readback','enable-timeout']).skipIf(process.platform!=='linux')('partial software keyboard setup restores state after %s',async failure=>{
  await withKeyboardAdb({previous:'0',failure},async(adb,state,_calls,pid)=>{
    const result=await ownedSoftwareKeyboard(adb,'emulator-5580',failure==='enable-timeout'?500:5000).catch(error=>error);
    expect(result).toBeInstanceOf(Error);expect(String(result)).not.toContain('private-keyboard-secret');
    expect(await state()).toBe('0');
    if(failure==='enable-timeout'){const ownedPid=await pid();expect(()=>process.kill(ownedPid,0)).toThrow();}
  });
});
test.each(['restore-failed','restore-applied']).skipIf(process.platform!=='linux')('software keyboard restoration failure remains explicit: %s',async failure=>{
  await withKeyboardAdb({previous:'0',failure},async(adb,state)=>{
    const owner=await ownedSoftwareKeyboard(adb,'emulator-5580');
    await expect(owner.restore()).rejects.toThrow('Owned software keyboard');
    expect(await state()).toBe(failure==='restore-applied'?'0':'1');
  });
});
test.skipIf(process.platform!=='linux')('unset software keyboard restoration survives a lost enabling acknowledgement',async()=>{
  await withKeyboardAdb({previous:'null',failure:'enable-applied'},async(adb,state,calls)=>{
    await expect(ownedSoftwareKeyboard(adb,'emulator-5580')).rejects.toThrow('unavailable: enable');
    expect(await state()).toBe('null');
    expect((await calls()).some(args=>args[4]==='delete')).toBe(true);
  });
});
test.skipIf(process.platform!=='linux')('keyboard setup keeps its primary failure when restoration also fails',async()=>{
  await withKeyboardAdb({previous:'0',failure:'enable-and-restore'},async(adb,state)=>{
    const warning=spyOn(console,'error').mockImplementation(()=>{});
    try {
      await expect(ownedSoftwareKeyboard(adb,'emulator-5580')).rejects.toThrow('unavailable: enable');
      expect(await state()).toBe('1');
      expect(warning.mock.calls).toContainEqual(['Owned Android SSH cleanup stage failed: software-keyboard']);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-keyboard-secret');
    } finally {warning.mockRestore();}
  });
});
test.skipIf(process.platform!=='linux')('keyboard read timeout retires its actual child before any mutation',async()=>{
  await withKeyboardAdb({previous:'0',failure:'read-timeout'},async(adb,state,calls,pid)=>{
    await expect(ownedSoftwareKeyboard(adb,'emulator-5580',500)).rejects.toThrow('unavailable: default IME');
    const ownedPid=await pid();expect(()=>process.kill(ownedPid,0)).toThrow();
    expect(await state()).toBe('0');expect(await calls()).toHaveLength(1);
  });
});

async function withHostAdbEndpoint(port:string,run:()=>Promise<void>,address?:string,socket?:string) {
  const values={ANDROID_ADB_SERVER_PORT:port,ANDROID_ADB_SERVER_ADDRESS:address,ADB_SERVER_SOCKET:socket};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  try {
    for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await run();
  } finally {
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}

test.each([
  {port:'5037',address:'remote-private-host'}, {port:'0'}, {port:'65536'}, {port:'05037'},
  {port:'5037; private-command'}, {port:'5037',socket:'tcp:private-socket'},
])('host ADB continuity rejects unsupported endpoint configuration: $port',async({port,address,socket})=>{
  await withHostAdbEndpoint(port,async()=>{
    expect(await hostAdbServerIdentity('/nonexistent-adb')).toEqual({state:'inconclusive',hash:null,reason:'unsupported-endpoint'});
  },address,socket);
});

test.skipIf(process.platform!=='linux')('host ADB continuity verifies only its owned listener and detects a replacement server',async()=>{
  const start=async(port=0)=>{
    const owned=new OwnedProcess(process.execPath,['-e',`require('node:net').createServer().listen(${port},'127.0.0.1',function(){process.stdout.write(String(this.address().port))})`]);
    try {
      const deadline=performance.now()+1000;
      while(!owned.stdout){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(5);}
      return {owned,port:Number(owned.stdout)};
    } catch(error){await owned.stop();throw error;}
  };
  const first=await start();let second:Awaited<ReturnType<typeof start>>|undefined;
  try {
    await withHostAdbEndpoint(String(first.port),async()=>{
      // This owned runtime listener tests OS ownership, not the ADB wire protocol.
      const before=await hostAdbServerIdentity(process.execPath);
      expect(before.state).toBe('available');expect(before.hash).toMatch(/^[a-f0-9]{64}$/);
      const original=await first.owned.liveIdentity();
      expect(before.hash).toBe(createHash('sha256').update(`${original!.pid}:${original!.start}`).digest('hex'));
      expect(compareHostAdbServer(before,await hostAdbServerIdentity(process.execPath))).toBe('same');
      expect(await hostAdbServerIdentity('/bin/sh')).toEqual({state:'inconclusive',hash:null,reason:'ownership-unverified'});
      expect(JSON.stringify(before)).not.toContain(String(first.owned.child.pid));
      await first.owned.stop();
      second=await start(first.port);
      const after=await hostAdbServerIdentity(process.execPath);
      expect(after.state).toBe('available');expect(compareHostAdbServer(before,after)).toBe('changed');
      await second.owned.stop();
      const missing=await hostAdbServerIdentity(process.execPath);
      expect(missing).toEqual({state:'inconclusive',hash:null,reason:'missing-listener'});
      expect(compareHostAdbServer(after,missing)).toBe('unknown');
      expect(compareHostAdbServer(missing,after)).toBe('unknown');
    });
  } finally {await first.owned.stop();await second?.owned.stop();}
},5000);

test.each([
  {body:'',code:0,reason:'missing-listener'},
  {body:'private-output',code:31,reason:'probe-unavailable'},
  {body:'',code:0,reason:'probe-unavailable',missing:true},
  {body:'private-output',code:0,reason:'unrecognized-listener'},
  {body:'LISTEN 0 1 127.0.0.1:45001 0.0.0.0:* cgroup:private/users:(("adb",pid=123,fd=1)) ino:1',code:0,reason:'unrecognized-listener'},
  {body:'LISTEN 0 1 127.0.0.1:45001 0.0.0.0:* users:(("adb",pid=2147483648,fd=1)) ino:1',code:0,reason:'unrecognized-listener'},
  {body:'x'.repeat(4097),code:0,reason:'overflow'},
  {body:'private-output',code:0,reason:'probe-unavailable',hang:true},
]).skipIf(process.platform!=='linux')('bounded host listener query reports $reason without raw data',async({body,code,reason,hang,missing})=>{
  const spawn=childProcess.spawn;
  let pid=0;
  const intercepted=spyOn(childProcess,'spawn').mockImplementation((program,args,options)=>{
    expect(program).toBe('/usr/bin/ss');
    expect(args).toEqual(['-H','-ltnpe','src 127.0.0.1 and sport = :45001']);
    if(missing)return spawn('/nonexistent-owned-ss',[],options);
    const child=spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(body)});${hang?'setInterval(()=>{},1000)':`process.exit(${code})`}`],options);
    pid=child.pid!;return child;
  });
  try {
    await withHostAdbEndpoint('45001',async()=>{
      expect(await hostAdbServerIdentity(process.execPath)).toEqual({state:'inconclusive',hash:null,reason});
      if(!missing)expect(()=>process.kill(pid,0)).toThrow();
    });
  } finally {intercepted.mockRestore();}
},5000);

test('host ADB comparison includes process start time and cannot bridge an inconclusive sample',()=>{
  const sample=(start:string)=>({state:'available' as const,hash:createHash('sha256').update(`123:${start}`).digest('hex')});
  expect(compareHostAdbServer(sample('10'),sample('11'))).toBe('changed');
  expect(compareHostAdbServer(undefined,sample('11'))).toBe('unknown');
  expect(compareHostAdbServer({state:'inconclusive',hash:null,reason:'probe-unavailable'},sample('11'))).toBe('unknown');
});

const bootA='00000000-0000-4000-8000-000000000001';
const bootB='00000000-0000-4000-8000-000000000002';
const continuityBody=(transport:string,boot:string,mapping=true)=>`device\n3438\n${mapping?'host tcp:46867 tcp:45678':''}\n${transport}\n${boot}\n`;

test.each([
  {transport:'42',boot:bootA,valid:true},
  {transport:'18446744073709551616',boot:bootA,valid:false},
  {transport:'0',boot:bootA,valid:false},
  {transport:'042',boot:bootA,valid:false},
  {transport:'private-transport',boot:'private-boot',valid:false},
  {transport:'1'.repeat(5000),boot:'a'.repeat(5000),valid:false,overflow:true},
])('owned identity probes hash only canonical bounded IDs: $valid',async({transport,boot,valid,overflow})=>{
  await withDiagnosticAdb(continuityBody(transport,boot),0,async(adb)=>{
    const result=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    expect(result.transport).toBe(overflow?'overflow':valid?'available':'unrecognized');
    expect(result.transportHash).toBe(valid?createHash('sha256').update(transport).digest('hex'):null);
    const validBoot=boot===bootA;
    expect(result.boot).toBe(overflow?'overflow':validBoot?'available':'unrecognized');
    expect(result.bootHash).toBe(validBoot?createHash('sha256').update(boot).digest('hex'):null);
    expect(JSON.stringify(result)).not.toContain(boot);
  });
});

test.each([
  {nextTransport:'42',nextBoot:bootA,mapping:true,expected:{transport:'same',boot:'same',reverseLost:false}},
  {nextTransport:'43',nextBoot:bootA,mapping:true,expected:{transport:'changed',boot:'same',reverseLost:false}},
  {nextTransport:'42',nextBoot:bootB,mapping:true,expected:{transport:'same',boot:'changed',reverseLost:false}},
  {nextTransport:'42',nextBoot:bootA,mapping:false,expected:{transport:'same',boot:'same',reverseLost:true}},
  {nextTransport:'unknown',nextBoot:'unknown',mapping:false,expected:{transport:'unknown',boot:'unknown',reverseLost:true}},
])('before/after observations compare without repairing or asserting cause: $expected',async({nextTransport,nextBoot,mapping,expected})=>{
  await withDiagnosticAdb(continuityBody('42',bootA),0,async(adb,args,fixture)=>{
    const before=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    await writeFile(fixture,continuityBody(nextTransport,nextBoot,mapping));
    const after=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    expect(compareEmulatorContinuity(before,after)).toEqual({...expected,adbd:'unknown'});
    expect(compareEmulatorContinuity(undefined,after)).toEqual({transport:'unknown',boot:'unknown',adbd:'unknown',reverseLost:null});
    expect((await readFile(args,'utf8')).trim().split('\n')).toHaveLength(12);
  });
});

const daemonStat=(pid:string,start:string)=>`${pid} (adbd) S ${Array.from({length:18},()=> '0').join(' ')} ${start} 0 0`;

test.each([
  {pid:'123',stat:daemonStat('123','456'),state:'available'},
  {pid:'123 124',stat:daemonStat('123','456'),state:'unrecognized'},
  {pid:'2147483648',stat:daemonStat('2147483648','456'),state:'unrecognized'},
  {pid:'123',stat:daemonStat('124','456'),state:'unrecognized'},
  {pid:'123',stat:daemonStat('123','0'),state:'unrecognized'},
  {pid:'123',stat:daemonStat('123','18446744073709551616'),state:'unrecognized'},
  {pid:'123',stat:daemonStat('123','456').replace('(adbd)','(private-secret)'),state:'unrecognized'},
  {pid:'123',stat:'private-secret'.repeat(500),state:'overflow'},
])('daemon sample validates identity and discards raw fields: $state',async({pid,stat,state})=>{
  await withDiagnosticAdb(continuityBody('42',bootA)+`${pid}\n${stat}\n`,0,async(adb,args)=>{
    const result=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    expect(result.adbd).toBe(state);
    expect(result.adbdHash).toBe(state==='available'?createHash('sha256').update('123:456').digest('hex'):null);
    expect(JSON.stringify(result)).not.toContain('private-secret');
    if(state==='available')expect((await readFile(args,'utf8')).split('\n')).toContain('-s emulator-5580 shell cat /proc/123/stat');
  });
});

test('daemon identity compares PID plus start tick without asserting cause',async()=>{
  const body=(start:string)=>continuityBody('42',bootA)+`123\n${daemonStat('123',start)}\n`;
  await withDiagnosticAdb(body('456'),0,async(adb,_args,fixture)=>{
    const before=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    expect(compareEmulatorContinuity(before,before).adbd).toBe('same');
    await writeFile(fixture,body('457'));
    const after=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    expect(compareEmulatorContinuity(before,after)).toEqual({transport:'same',boot:'same',adbd:'changed',reverseLost:false});
    expect(JSON.stringify(after)).not.toContain('123:457');
  });
});

// Android16 adb_listeners.cpp129 and daemon/transport_socket_server.cpp78 generate these labels.
test.each(['host-35','(reverse)'])('reverse metadata is discarded on the explicitly selected owned transport: %s',async metadata=>{
  const body=continuityBody('42',bootA).replace('host tcp:',metadata+' tcp:');
  await withDiagnosticAdb(body,0,async(adb,args)=>{
    const summary=await emulatorContinuity(adb,'emulator-5580','46867',45678);
    expect(summary.reverse).toBe('present');
    expect(JSON.stringify(summary)).not.toContain(metadata);
    expect((await readFile(args,'utf8')).split('\n')).toContain('-s emulator-5580 reverse --list');
  });
});

test.each([
  {label:'crash text',stdout:"Instrumentation run failed due to 'Process crashed.'",stderr:'',expected:['processCrash']},
  {label:'disconnect class',stdout:'',stderr:'com.android.ddmlib.DeviceDisconnectedException: private-secret',expected:['deviceUnavailable']},
  {label:'offline message',stdout:'adb: device offline',stderr:'',expected:['deviceUnavailable']},
  {label:'rejected command',stdout:'',stderr:'com.android.ddmlib.AdbCommandRejectedException: private-secret',expected:['adbRejected']},
  {label:'reset message',stdout:'',stderr:'java.net.SocketException: Connection reset by peer',expected:['connectionReset']},
  {label:'timeout class',stdout:'com.android.ddmlib.TimeoutException',stderr:'',expected:['deadlineReported']},
  {label:'unresponsive command',stdout:'',stderr:'com.android.ddmlib.ShellCommandUnresponsiveException',expected:['deadlineReported']},
  {label:'incomplete result',stdout:'Test run failed to complete. Expected 1 tests, received 0',stderr:'',expected:['incompleteRun']},
  {label:'instrumentation result',stdout:'INSTRUMENTATION_FAILED',stderr:'',expected:['incompleteRun']},
  {label:'multiple messages',stdout:'Process crashed\nINSTRUMENTATION_FAILED',stderr:'',expected:['processCrash','incompleteRun']},
  {label:'unknown private message',stdout:'private-secret',stderr:'another-private-secret',expected:[]},
  {label:'empty buffer',stdout:'',stderr:'',expected:[]},
  {label:'expired output window',stdout:'Process crashed'+'x'.repeat(16384),stderr:'',expected:[]},
])('Gradle diagnostics retain only known flags, not content or a cause: $label',({stdout,stderr,expected})=>{
  const flags=gradleFailureClasses(stdout,stderr);
  expect(flags.scope).toBe('last-output-window-only');
  expect(Object.keys(flags).sort()).toEqual(['scope','processCrash','deviceUnavailable','adbRejected','connectionReset','deadlineReported','incompleteRun','unclassified'].sort());
  const selected=Object.entries(flags).filter(([key,value])=>key!=='unclassified' && value===true).map(([key])=>key);
  expect(selected).toEqual(expected);
  expect(flags.unclassified).toBe(expected.length===0);
  expect(JSON.stringify(flags)).not.toContain('private-secret');
});

const junit=(...cases:string[])=>`<?xml version='1.0' encoding='UTF-8' ?>\n<testsuites tests="${cases.length}" failures="${cases.length}">\n  <testsuite name="app.lazysh.client.NativeWorkspaceTest">\n${cases.join('')}  </testsuite>\n</testsuites>\n`;
const failedCase=(name:string,message:string,...frames:string[])=>`    <testcase name="${name}" classname="app.lazysh.client.NativeWorkspaceTest" time="1.0">\n      <failure>${message}\n${frames.map(frame=>`at ${frame}\n`).join('')}</failure>\n    </testcase>\n`;

test('instrumentation failures name the failed case, its message and the first app frame from a JUnit file',()=>{
  const xml=junit('    <testcase name="passes" classname="app.lazysh.client.NativeWorkspaceTest" time="1.0"/>\n',
    failedCase('ownedSshDpadPanThroughRealUi','java.lang.AssertionError: Original trusted contact: receipt={&quot;trusted&quot;:false} &lt;ok&gt;','org.junit.Assert.fail(Assert.java:89)',
      'app.lazysh.client.NativeWorkspaceTest.verifyPastBottomKeyboardDismiss$stroke$received(NativeWorkspaceTest.kt:5243)','app.lazysh.client.NativeWorkspaceTest.ownedSshUi(NativeWorkspaceTest.kt:4005)'));
  expect(instrumentationFailures(xml)).toEqual([{test:'ownedSshDpadPanThroughRealUi',
    failure:'java.lang.AssertionError: Original trusted contact: receipt={"trusted":false} <ok>',
    at:'at app.lazysh.client.NativeWorkspaceTest.verifyPastBottomKeyboardDismiss$stroke$received(NativeWorkspaceTest.kt:5243)'}]);
  // An error raised by a class-level @BeforeClass has no test name; its frame is still named.
  expect(instrumentationFailures(junit(failedCase('null','java.lang.IllegalStateException: Fingerprint enrollment did not complete after 314 touches',
    'app.lazysh.client.NativeBiometricVaultTest$Companion.enroll(NativeBiometricVaultTest.kt:130)')))).toEqual([{test:'null',
    failure:'java.lang.IllegalStateException: Fingerprint enrollment did not complete after 314 touches',
    at:'at app.lazysh.client.NativeBiometricVaultTest$Companion.enroll(NativeBiometricVaultTest.kt:130)'}]);
});

test('instrumentation failures are bounded, printable and mask nonces, and ignore text that is not a failed case',()=>{
  const many=instrumentationFailures(junit(...Array.from({length:6},(_,index)=>failedCase(`case${index}`,`java.lang.AssertionError: ${'x'.repeat(900)}`))));
  expect(many.map(item=>item.test)).toEqual(['case0','case1','case2','case3']);
  expect(many.every(item=>item.failure.length===400)).toBe(true);
  const masked=instrumentationFailures(junit(failedCase('masked',`java.lang.AssertionError: nonce ${'0123456789abcdef'.repeat(2)} \u001b[31mred\u0007`)))[0];
  expect(masked.failure).toBe('java.lang.AssertionError: nonce <nonce> ?[31mred?');
  expect(instrumentationFailures('private-secret\n<testcase name="skipped"><skipped/></testcase>\n')).toEqual([]);
  expect(instrumentationFailures('')).toEqual([]);
});

test('the failure report reads every JUnit file below its results directory and never throws',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-junit-report-'));
  const logged=spyOn(console,'error').mockImplementation(()=>{});
  try {
    await reportInstrumentationFailures(join(directory,'absent'));
    await reportInstrumentationFailures(directory);
    expect(logged).not.toHaveBeenCalled();
    const device=join(directory,'connected/debug/flavors/universal');
    await mkdir(device,{recursive:true});
    await writeFile(join(device,'TEST-device-_app-universal.xml'),junit(failedCase('ownedSshUi','java.lang.AssertionError: boom','app.lazysh.client.NativeWorkspaceTest.ownedSshUi(NativeWorkspaceTest.kt:4005)')));
    await writeFile(join(device,'TEST-huge.xml'),junit(failedCase('oversized','x'.repeat(300_000))));
    await writeFile(join(device,'notes.txt'),junit(failedCase('ignored','not a result file')));
    await reportInstrumentationFailures(directory);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('Owned instrumentation failure '+JSON.stringify([{test:'ownedSshUi',failure:'java.lang.AssertionError: boom',at:'at app.lazysh.client.NativeWorkspaceTest.ownedSshUi(NativeWorkspaceTest.kt:4005)'}]));
  } finally {logged.mockRestore();await rm(directory,{recursive:true,force:true});}
});

const nonce='a'.repeat(32);
const row=(tag:string,message:string,pid=123)=>`10-28 01:37:10.123 ${pid} 124 F ${tag}: ${message}\n`;
const marker=(verb='start',pid=123,value=nonce)=>row('LazyshOwnedCase',`${verb}:${value}:pid:${pid}`,pid);
const java=(pid=123)=>row('AndroidRuntime','FATAL EXCEPTION: private-secret',pid);
const native=(target=123,process='app.lazysh.client')=>row('DEBUG',`pid: ${target}, tid: ${target}, name: private-name  >>> ${process} <<<`,999)+
  row('DEBUG','uid: 10155',999)+row('DEBUG','signal 11 (SIGSEGV), code 1, fault addr private-address',999);

const persistedJava=(exception='java.lang.IllegalStateException',pid=123)=>java(pid)+
  row('AndroidRuntime',`Process: app.lazysh.client, PID: ${pid}`,pid)+
  row('AndroidRuntime',`${exception}: private-secret /private/path`,pid)+
  row('AndroidRuntime','\tat app.lazysh.privateSecret.method(private-file:42)',pid);

test.each(['missing','foreign','mismatched-pid','ended','overflow'] as const)('persisted recovery requires an unfinished original marker: %s',async kind=>{
  const parser=new OwnedCaseCrashParser(nonce);
  const input=kind==='foreign'?marker('start',123,'b'.repeat(32)):kind==='mismatched-pid'?row('LazyshOwnedCase',`start:${nonce}:pid:456`):kind==='missing'?'':marker();
  parser.push(Buffer.from(input+(kind==='ended'?marker('end'):kind==='overflow'?'x'.repeat(1025):'')));
  expect(parser.persistedParser()).toBeUndefined();
  expect(await recoverOwnedCaseCrash('/nonexistent-owned-adb','emulator-5580',parser)).toEqual({state:'ineligible',exceptions:[]});
});

test('persisted framing rejects stale/foreign/unanchored crashes and keeps only closed categories',()=>{
  const original=new OwnedCaseCrashParser(nonce);
  original.push(Buffer.from(marker()+marker('start',456)));
  const target=original.persistedParser()!;
  expect({pid:target.pid,time:target.time}).toEqual({pid:123,time:'10-28 01:37:10.123'});
  const data=Buffer.from(persistedJava().replaceAll('01:37:10.123','01:37:09.999')+persistedJava('java.lang.SecurityException',456)+
    row('AndroidRuntime','java.lang.NullPointerException: unanchored-private')+java()+
    row('AndroidRuntime','Process: other.app, PID: 123')+row('AndroidRuntime','java.lang.NullPointerException: foreign-private')+
    persistedJava()+row('AndroidRuntime','Caused by: private.secret.Exception: secret-key')+
    persistedJava('java.lang.OutOfMemoryError'));
  for(const byte of data)target.parser.push(Buffer.from([byte]));
  target.parser.finish();
  expect(target.parser.recoverySummary()).toEqual({overflow:false,exceptions:['illegal-state','other','out-of-memory']});
  expect(original.summary()).toMatchObject({correlated:true,ended:false,records:[]});
  expect(JSON.stringify(target.parser.recoverySummary())).not.toMatch(/private|secret|path|Exception|app[.]lazysh/);
});

test('persisted recovery retains bounded wrapped JNI causes beyond the first framework frames',()=>{
  const original=new OwnedCaseCrashParser(nonce);original.push(Buffer.from(marker()));
  const parser=original.persistedParser()!.parser;
  parser.push(Buffer.from(persistedJava('java.lang.RuntimeException')+
    row('AndroidRuntime','\tat android.app.ActivityThread.performResumeActivity(ActivityThread.java:1)').repeat(32)+
    row('AndroidRuntime','Caused by: java.lang.NoSuchMethodError: private-method-and-arguments')));
  parser.finish();
  expect(parser.recoverySummary()).toEqual({overflow:false,exceptions:['runtime','method-linkage']});
});

test.each(['line','total','records','window','unfinished-line'] as const)('persisted parser enforces %s bounds',kind=>{
  const original=new OwnedCaseCrashParser(nonce);original.push(Buffer.from(marker()));
  const parser=original.persistedParser()!.parser;
  const input=kind==='line'?'x'.repeat(1025):kind==='total'?'x\n'.repeat(32769):
    kind==='records'?persistedJava().repeat(12):kind==='unfinished-line'?persistedJava().split('\n').slice(0,3).join('\n'):
    java()+row('AndroidRuntime','Process: app.lazysh.client, PID: 123')+row('AndroidRuntime','private-noise').repeat(64)+row('AndroidRuntime','java.lang.NullPointerException: stale');
  parser.push(Buffer.from(input));parser.finish();
  expect(parser.recoverySummary()).toEqual({overflow:kind==='line'||kind==='total',exceptions:
    kind==='records'?Array(8).fill('illegal-state'):kind==='unfinished-line'?['illegal-state']:[]});
});

test.each([
  {body:persistedJava(),code:0,state:'available',exceptions:['illegal-state']},
  {body:persistedJava('java.lang.SecurityException',456),code:0,state:'empty',exceptions:[]},
  {body:persistedJava(),code:31,state:'unavailable',exceptions:[]},
  {body:persistedJava()+'x'.repeat(1025),code:0,state:'overflow',exceptions:[]},
])('owned persisted child reports $state separately from live failure',async({body,code,state,exceptions})=>{
  await withDiagnosticAdb(body,code,async(adb,args)=>{
    const original=new OwnedCaseCrashParser(nonce);original.push(Buffer.from(marker()));
    original.pushStderr(Buffer.from('logcat: Unexpected EOF! private-secret\n'));
    const live=original.summary();
    expect(await recoverOwnedCaseCrash(adb,'emulator-5580',original)).toEqual({state,exceptions});
    expect(original.summary()).toEqual(live);
    expect(await readFile(args,'utf8')).toBe('-s emulator-5580 logcat -b crash -d --pid 123 -T 10-28 01:37:10.123 -v threadtime AndroidRuntime:E *:S\n');
  });
});

test('persisted child rejects unowned serials and reports spawn errors without private output',async()=>{
  const parser=new OwnedCaseCrashParser(nonce);parser.push(Buffer.from(marker()));
  expect(await recoverOwnedCaseCrash('/nonexistent-owned-adb','personal-device',parser)).toEqual({state:'ineligible',exceptions:[]});
  expect(await recoverOwnedCaseCrash('/nonexistent-owned-adb','emulator-5580',parser)).toEqual({state:'unavailable',exceptions:[]});
});

test.each([
  {tail:'setInterval(()=>{},1000)',state:'unavailable'},
  {tail:"process.stderr.write('x'.repeat(65537));setInterval(()=>{},1000)",state:'overflow'},
]).skipIf(process.platform!=='linux')('persisted child $state retires its owned process without retaining partial evidence',async({tail,state})=>{
  await withDiagnosticAdb('',0,async(adb,args,fixture)=>{
    await writeFile(adb,`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.EXIT_INFO_FIXTURE,String(process.pid));process.stdout.write(${JSON.stringify(persistedJava())});process.stderr.write('private-secret');${tail};\n`);
    const parser=new OwnedCaseCrashParser(nonce);parser.push(Buffer.from(marker()));
    expect(await recoverOwnedCaseCrash(adb,'emulator-5580',parser)).toEqual({state,exceptions:[]});
    const pid=Number(await readFile(fixture,'utf8'));
    expect(pid).toBeGreaterThan(0);expect(()=>process.kill(pid,0)).toThrow();
  });
},5000);

test.each([
  {packageName:'app.lazysh.client',reason:'finished inst',expected:'finished-instrumentation'},
  {packageName:'app.lazysh.client',reason:'start instr',expected:'start-instrumentation'},
  {packageName:'app.lazysh.client',reason:'from pid 2345',expected:'external-request'},
  {packageName:'app.lazysh.client',reason:'from pid 2345 (private-caller)',expected:'external-request'},
  {packageName:'app.lazysh.client',reason:'private-trigger',expected:'other'},
  {packageName:'app.lazysh.client.test',reason:'finished inst',expected:null},
  {packageName:'app.lazysh.client.other',reason:'finished inst',expected:null},
  {packageName:'other.app',reason:'finished inst',expected:null},
])('package force-stop classification retains a finite reason only: $packageName/$expected',({packageName,reason,expected})=>{
  const parser=new OwnedCaseCrashParser(nonce);
  const event=row('ActivityManager',`Force stopping ${packageName} appid=10155 user=0: ${reason}`,624);
  parser.push(Buffer.from(event));
  expect(parser.summary().forceStop).toEqual({state:'unknown',records:[]});
  parser.push(Buffer.from(marker()+event));
  const records=expected?[{time:'10-28 01:37:10.123',reason:expected}]:[];
  expect(parser.summary().forceStop).toEqual({state:expected?'reported':'unknown',records});
  parser.push(Buffer.from(marker('end')+event));
  expect(parser.summary().forceStop.records).toEqual(records);
  expect(JSON.stringify(parser.summary())).not.toMatch(/private-|2345|10155|app[.]lazysh|other[.]app/);
});

test('force-stop rows share the eight-record limit with fatal records and reject malformed boundaries',()=>{
  const parser=new OwnedCaseCrashParser(nonce);
  const event=(appid:string,user:string)=>row('ActivityManager',`Force stopping app.lazysh.client appid=${appid} user=${user}: finished inst`,624);
  parser.push(Buffer.from(marker()+event('2147483648','0')+event('10155','-2')+row('ActivityManager','prefix Force stopping app.lazysh.client appid=10155 user=0: finished inst',624)));
  expect(parser.summary().forceStop.state).toBe('unknown');
  parser.push(Buffer.from(java()+event('10155','0').repeat(10)+native()));
  expect(parser.summary().records).toHaveLength(1);
  expect(parser.summary().forceStop.records).toHaveLength(7);
});

test('owned case crash records require the exact live marker and emitting PID',()=>{
  const parser=new OwnedCaseCrashParser(nonce);
  parser.push(Buffer.from(java()+native()+marker('start',456,'b'.repeat(32))+java(456)));
  expect(parser.summary().correlated).toBe(false);
  parser.push(Buffer.from(row('LazyshOwnedCase',`start:${nonce}:pid:123`,456)+java()));
  expect(parser.summary().correlated).toBe(false);
  parser.push(Buffer.from(marker()+java(456)+native(456)+native(123,'other.app')+java()+native()));
  expect(parser.summary().records).toEqual([
    {kind:'java',pid:123,time:'10-28 01:37:10.123'},
    {kind:'native',pid:123,time:'10-28 01:37:10.123',signal:11},
  ]);
  expect(JSON.stringify(parser.summary())).not.toMatch(/private|address|name|SIGSEGV|app\.lazysh|aaaa/);
});

test('case end and a second process never rebind the original case window',()=>{
  const parser=new OwnedCaseCrashParser(nonce);
  parser.push(Buffer.from(marker()+marker('start',456)+java(456)+marker('end',456)+java()+marker('end')+java()+native()));
  expect(parser.summary()).toMatchObject({correlated:true,ended:true,overflow:false});
  expect(parser.summary().records).toHaveLength(1);
});

test('fragmented native records retain only finite correlated fields',()=>{
  const parser=new OwnedCaseCrashParser(nonce);
  const data=Buffer.from(marker()+native());
  for(const value of data)parser.push(Buffer.from([value]));
  expect(parser.summary().records).toEqual([{kind:'native',pid:123,time:'10-28 01:37:10.123',signal:11}]);
});

test('native records require the same debugger emitter within a bounded header window',()=>{
  const parser=new OwnedCaseCrashParser(nonce);
  parser.push(Buffer.from(marker()+native().split('\n')[0]+'\n'+row('DEBUG','signal 11 (SIGSEGV), private',998)));
  expect(parser.summary().records).toHaveLength(0);
  parser.push(Buffer.from(row('DEBUG','unrelated').repeat(16)+row('DEBUG','signal 11 (SIGSEGV), private',999)));
  expect(parser.summary().records).toHaveLength(0);
});

test('any foreign or malformed native process header retires the previous owned header',()=>{
  const parser=new OwnedCaseCrashParser(nonce);
  const owned=native().split('\n')[0]+'\n';
  parser.push(Buffer.from(marker()+owned+native(456,'other.app')));
  expect(parser.summary().records).toHaveLength(0);
  parser.push(Buffer.from(owned+row('DEBUG','pid: malformed private-header',999)+row('DEBUG','signal 11 (SIGSEGV), private',999)));
  expect(parser.summary().records).toHaveLength(0);
});

test.each(['line','total','records'] as const)('crash classifier enforces its %s bound without retaining content',kind=>{
  const parser=new OwnedCaseCrashParser(nonce);
  parser.push(Buffer.from(marker()));
  if(kind==='line')parser.push(Buffer.from('private'.repeat(200)));
  if(kind==='total')parser.push(Buffer.alloc(64*1024,120));
  if(kind==='records')parser.push(Buffer.from(java().repeat(20)));
  expect(parser.summary().overflow).toBe(kind!=='records');
  expect(parser.summary().records).toHaveLength(kind==='records'?8:0);
  expect(JSON.stringify(parser.summary())).not.toContain('private');
});

test.each([
  {text:'logcat: Unexpected EOF! private-secret',flag:'unexpectedEof'},
  {text:'logcat: Logcat read failure: private-secret',flag:'readFailure'},
  {text:'logcat: Unexpected length. private-secret',flag:'readFailure'},
  {text:'adb: device offline private-secret',flag:'deviceUnavailable'},
  {text:'- waiting for device -',flag:'waitingForDevice'},
  {text:'private-secret',flag:'other'},
  {text:'',flag:null},
])('collector stderr retains fixed flags only: $flag',({text,flag})=>{
  const parser=new OwnedCaseCrashParser(nonce);
  for(const byte of Buffer.from(text))parser.pushStderr(Buffer.from([byte]));
  parser.finish();
  expect(Object.entries(parser.summary().stderr).filter(([,selected])=>selected).map(([name])=>name)).toEqual(flag?[flag]:[]);
  expect(JSON.stringify(parser.summary())).not.toContain('private-secret');
  expect(parser.summary().overflow).toBe(false);
});

test('stdout and stderr share the same total and per-line diagnostic bounds',()=>{
  const parser=new OwnedCaseCrashParser(nonce);
  parser.push(Buffer.from('x\n'.repeat(16384)));
  parser.pushStderr(Buffer.from('y\n'.repeat(16385)));
  expect(parser.summary().overflow).toBe(true);
  const long=new OwnedCaseCrashParser(nonce);
  long.pushStderr(Buffer.from('private-secret'.repeat(100)));
  expect(long.summary().overflow).toBe(true);
  long.finish();
  expect(long.summary().stderr.other).toBe(false);
});

for(const mode of ['hold','exit255','reported-eof','signal','overflow','stop-failure'] as const) {
test.skipIf(process.platform!=='linux')(`owned crash collector records ${mode} provenance without raw output`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-case-crash-'));
  const adb=join(directory,'adb'),args=join(directory,'argv'),pidFile=join(directory,'pid'),gate=join(directory,'continue');
  let collector:ReturnType<typeof captureOwnedCaseCrashes>|undefined;
  let restoreStop:(()=>void)|undefined;
  try {
    // Native Bun fixture executable; never launches a user adb/session or shell.
    const action=mode==='exit255'?'process.exit(255)':mode==='reported-eof'?`process.stderr.write('logcat: Unexpected EOF! private-secret',()=>process.exit(1))`:mode==='signal'?`process.kill(process.pid,'SIGTERM')`:mode==='overflow'?`process.stderr.write('private-secret'.repeat(6000));setInterval(()=>{},1000)`:'setInterval(()=>{},1000)';
    await writeFile(adb,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write(${JSON.stringify(marker()+java())});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);${action}}},5);\n`);
    await chmod(adb,0o700);
    collector=captureOwnedCaseCrashes(adb,'emulator-5580',nonce);
    const deadline=performance.now()+1000;
    while(!await Bun.file(pidFile).exists()) {expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(5);}
    while(collector.snapshot().records.length===0) {expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(5);}
    // Admit the synthetic exit only after the host observed this child's marker.
    await writeFile(gate,'');
    if(mode!=='hold' && mode!=='stop-failure')while(collector.snapshot().close.phase==='unobserved') {expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(5);}
    if(mode==='stop-failure') {
      const originalStop=OwnedProcess.prototype.stop;
      const failure=spyOn(OwnedProcess.prototype,'stop').mockImplementation(async function(this:OwnedProcess){await originalStop.call(this);throw new Error('private-stop-error');});
      restoreStop=()=>failure.mockRestore();
    }
    const beforeStop=collector.elapsedMs();
    const summary=await collector.stop();
    expect(summary.close.elapsedMs!).toBeLessThanOrEqual(collector.elapsedMs());
    if(mode==='hold'||mode==='stop-failure')expect(summary.close.elapsedMs!).toBeGreaterThanOrEqual(beforeStop);
    expect(summary.stream).toBe(mode==='hold'?'stopped':mode==='overflow'?'overflow':'unavailable');
    expect(summary.correlated).toBe(true);
    expect(summary.records).toHaveLength(1);
    expect(summary.close.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(summary.close.elapsedMs).toBeLessThanOrEqual(1000);
    expect(summary.close).toEqual({elapsedMs:summary.close.elapsedMs,phase:mode==='hold'||mode==='overflow'||mode==='stop-failure'?'during-stop':'before-stop',exitCode:mode==='exit255'?255:mode==='reported-eof'?1:null,signal:mode==='exit255'||mode==='reported-eof'?'none':'SIGTERM',processError:false,stopFailed:mode==='stop-failure'});
    expect(summary.stderr.unexpectedEof).toBe(mode==='reported-eof');
    expect(JSON.stringify(summary)).not.toMatch(/private-secret|private-stop-error/);
    expect(JSON.parse(await readFile(args,'utf8'))).toEqual(['-s','emulator-5580','logcat','-b','main','-b','crash','-b','system','-v','threadtime','-T','1','LazyshOwnedCase:I','AndroidRuntime:E','DEBUG:F','ActivityManager:I','*:S']);
    const pid=Number(await readFile(pidFile,'utf8'));
    expect(()=>process.kill(pid,0)).toThrow();
    expect(await collector.stop()).toEqual(summary);
  } finally {restoreStop?.();await collector?.stop();await rm(directory,{recursive:true,force:true});}
});
}

test('collector process-start failure is finite and cannot masquerade as a correlated stream',async()=>{
  const collector=captureOwnedCaseCrashes('/nonexistent-owned-case-adb','emulator-5580',nonce);
  const deadline=performance.now()+1000;
  try {
    while(collector.snapshot().close.phase==='unobserved') {expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(5);}
    const summary=await collector.stop();
    expect(summary).toMatchObject({stream:'unavailable',correlated:false,close:{phase:'before-stop',exitCode:null,signal:'none',processError:true,stopFailed:true}});
    expect(JSON.stringify(summary)).not.toContain('nonexistent');
  } finally {await collector.stop();}
});

test('native keyboard oracle uses fractional visible bounds and rejects overflow, offset clipping and unavailable geometry',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-keyboard-viewport.js'),'utf8');
  const contains=new Function(`${source}; return ownedKeyboardViewportContains;`)();
  const viewport={offsetLeft:0,offsetTop:0,width:412.19049072265625,height:365.33331298828125,scale:1};
  const rect=(left:number,top:number,right:number,bottom:number)=>({left,top,right,bottom,width:right-left,height:bottom-top});
  const geometry=[rect(0,155.762,viewport.width,181.786),rect(0,282.81,viewport.width,338.571),rect(6,291.571,41.53,330.571),rect(91.06,291.571,126.589,330.571)];
  expect(geometry[0].right>Math.trunc(viewport.width)).toBe(true);
  expect(contains(viewport,geometry)).toBe(true);
  for(const index of [0,1,2,3]){
    const overflow=geometry.map((value,i)=>i===index?rect(value.left,value.top,viewport.width+1/64,value.bottom):value);
    expect(contains(viewport,overflow)).toBe(false);
  }
  expect(contains(viewport,geometry.map((value,i)=>i===2?rect(-180,value.top,-144,value.bottom):value))).toBe(false);
  const shifted={...viewport,offsetLeft:10.25,offsetTop:20.5};
  const shiftedGeometry=geometry.map(value=>rect(value.left+shifted.offsetLeft,value.top+shifted.offsetTop,value.right+shifted.offsetLeft,value.bottom+shifted.offsetTop));
  expect(contains(shifted,shiftedGeometry)).toBe(true);
  for(const field of ['left','top'])expect(contains(shifted,shiftedGeometry.map((value,i)=>i===0?{...value,[field]:shifted[field==='left'?'offsetLeft':'offsetTop']-1/64}:value))).toBe(false);
  for(const invalid of [null,{...viewport,width:0},{...viewport,height:NaN},{...viewport,scale:Infinity},{...viewport,offsetTop:undefined}])expect(contains(invalid,geometry)).toBe(false);
  expect(contains(viewport,geometry.slice(1))).toBe(false);
  expect(contains(viewport,geometry.map((value,i)=>i===0?{...value,height:0}:value))).toBe(false);
});

test('passive native tap evidence retains only bounded trusted/target flags and removes its own listeners',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-native-tap.js'),'utf8');
  const listeners=new Map<string,(event:unknown)=>void>();
  const target={value:'private-key-material',disabled:false,isConnected:true,getBoundingClientRect:()=>({left:1,top:2,right:101,bottom:42,width:100,height:40})};
  const window={innerWidth:412,innerHeight:365,devicePixelRatio:2.625,visualViewport:{width:412.19,height:365.33,offsetLeft:0,offsetTop:0,scale:1},
    addEventListener(type:string,listener:(event:unknown)=>void,options:unknown){expect(options).toEqual({capture:true,passive:true});listeners.set(type,listener);},
    removeEventListener(type:string,listener:unknown,capture:boolean){expect(capture).toBe(true);if(listeners.get(type)===listener)listeners.delete(type);}};
  const observe=new Function('window',`${source};return ownedNativeTapObservation;`)(window)(target);
  listeners.get('pointerdown')!({isTrusted:true,target,clientX:51,clientY:22,message:'private-data',preventDefault(){throw new Error('Must remain passive');}});
  listeners.get('pointerup')!({isTrusted:false,target:{value:'other-private-value'},clientX:Infinity,clientY:NaN});
  for(let count=0;count<4;count++)listeners.get('click')!({isTrusted:true,target,clientX:51,clientY:22});
  const sample=observe.read();
  expect(sample.before).toMatchObject({enabled:true,connected:true,focused:false});
  expect(sample.down).toEqual({count:1,overflow:false,trusted:true,target:true,point:[51,22]});
  expect(sample.up).toEqual({count:1,overflow:false,trusted:false,target:false,point:[null,null]});
  expect(sample.click.count).toBe(2);expect(sample.click.overflow).toBe(true);
  expect(JSON.stringify(sample)).not.toContain('private');
  expect(observe.close()).toBe(true);expect(listeners.size).toBe(0);expect(observe.close()).toBe(true);
  expect(observe.read().closed).toBe(true);
});
test('partial passive tap setup failure attempts listener cleanup without exposing private error text',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-native-tap.js'),'utf8');
  const attached=new Set<string>();let calls=0;
  const window={visualViewport:null,addEventListener(type:string){if(++calls===2)throw new Error('private-setup-failure');attached.add(type);},removeEventListener(type:string){attached.delete(type);}};
  const create=new Function('window',`${source};return ownedNativeTapObservation;`)(window);
  expect(()=>create({getBoundingClientRect:()=>({})})).toThrow('Owned native tap observation unavailable');
  expect(attached.size).toBe(0);
});

test('Herdr discovery observation retains only closed state and capped counts',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const script=source.match(/val discoveryObservation = """([\s\S]*?)"""[.]trimIndent\(\)/)![1]
    .replaceAll("${'$'}",'$').replace('$childDisconnect',JSON.stringify("button[aria-label='Disconnect owned child']"));
  const observe=new Function('document',`return (${script.trim()});`);
  let panels:unknown[]=[],buttons=[{textContent:'List herdr sessions',disabled:false}];
  let capability='tmux 3.4 (Supported) · Herdr 0.9.5 (Supported) · Zellij not installed';
  let endedText:string|undefined,childPresent=true,childSelected=false;
  const otherSelected={private:'another selected tab must not establish child ownership'};
  const child={closest:(selector:string)=>selector==='.session-tab'?{
    querySelector:(selector:string)=>selector==='[role=tab][aria-selected=true]'&&childSelected?{private:'owned selected tab'}:null,
  }:null};
  const document={querySelector:(selector:string)=>{
    if(selector==="button[aria-label='Disconnect owned child']")return childPresent?child:null;
    if(selector==='.session-body > .panel-empty h3')return endedText===undefined?null:{textContent:endedText};
    if(selector==='[role=tab][aria-selected=true]')return otherSelected;
    return null;
  },querySelectorAll:(selector:string)=>{
    if(selector==='.multiplexer-panel')return panels;
    if(selector.includes('aria-current=page'))return [{textContent:'Sessions'}];
    return Array(17).fill({private:'never retain this'});
  }};
  const absent=observe(document);
  expect(absent).toEqual({panelCount:0,loading:false,inlineError:false,herdrCapability:'unknown',listCount:0,listEnabled:false,
    sessionsSelected:true,terminalSelected:false,menuCount:8,tabsCount:8,terminalCount:8,childDisconnect:true,endedPlaceholder:false,expectedChildTabSelected:false});
  for(const ended of [false,true])for(const selected of [false,true]){
    endedText=ended?'This connection has ended.':undefined;childSelected=selected;
    expect(observe(document)).toMatchObject({endedPlaceholder:ended,expectedChildTabSelected:selected});
  }
  for(const text of ['private receiver output','This connection has ended. private trailing output','private prefix This connection has ended.']){
    endedText=text;childSelected=false;
    expect(observe(document)).toMatchObject({endedPlaceholder:false,expectedChildTabSelected:false});
    expect(JSON.stringify(observe(document))).not.toContain('private');
  }
  endedText='This connection has ended.';childSelected=true;childPresent=false;
  expect(observe(document)).toMatchObject({endedPlaceholder:true,childDisconnect:false,expectedChildTabSelected:false});
  endedText=undefined;childPresent=true;childSelected=false;
  const panel={querySelectorAll:()=>buttons,querySelector:(selector:string)=>selector==='p.muted'?{textContent:capability}: {private:'never retain this'}};
  panels=[panel];
  const present=observe(document);
  expect(present).toMatchObject({panelCount:1,loading:true,inlineError:true,herdrCapability:'detected',listCount:1,listEnabled:true});
  for(const value of ['missing','private path/error and host']){
    capability=value==='missing'?'Herdr not installed':value;
    expect(observe(document).herdrCapability).toBe(value==='missing'?'missing':'unknown');
  }
  buttons=[{textContent:'List herdr sessions',disabled:true}];
  expect(observe(document)).toMatchObject({listCount:1,listEnabled:false});
  buttons=Array(17).fill({textContent:'List herdr sessions',disabled:false});
  expect(observe(document)).toMatchObject({listCount:8,listEnabled:false});
  panels=[panel,panel];
  expect(observe(document)).toMatchObject({panelCount:2,herdrCapability:'unknown',listCount:0});
  expect(JSON.stringify(observe(document))).not.toContain('private');
  expect(Object.values(present).every(value=>typeof value==='boolean'||Number.isInteger(value)||['detected','missing','unknown'].includes(value as string))).toBe(true);
});

async function herdrConfirmationFixture() {
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const source=kotlin.match(/private fun herdrConfirmationObservation\([\s\S]*?val expression = """([\s\S]*?)"""/)!;
  expect(source).not.toBeNull();
  const child='owned/private-child',draft='private-draft-path-and-token';
  const expression=source[1].replaceAll('${JSONObject.quote(expectedChild)}',JSON.stringify(child)).replaceAll('${JSONObject.quote(expectedDraft)}',JSON.stringify(draft));
  type Button={textContent:string;disabled:boolean};
  type Region={buttons?:Button[];alerts?:string[];statuses?:string[]};
  const observe=({regions=[],tabs=[],footer=[],value}:{regions?:Region[];tabs?:{textContent:string;idle:boolean}[];footer?:string[];value?:string}={})=>{
    const document={
      querySelectorAll(selector:string) {
        if(selector==="section[aria-label='Terminal input']")return regions.map(region=>({querySelectorAll(selector:string){
          if(selector==='button')return region.buttons??[];
          if(selector==='[role=alert]')return (region.alerts??[]).map(textContent=>({textContent}));
          if(selector==='[role=status]')return (region.statuses??[]).map(textContent=>({textContent}));
          throw new Error('Unexpected regional query');
        }}));
        if(selector==='.session-tabs [role=tab]')return tabs.map(tab=>({textContent:tab.textContent,querySelector:()=>tab.idle?{}:null}));
        throw new Error('Unexpected global query');
      },
      querySelector(selector:string) {
        if(selector==='.workspace-footer > span:last-child')return footer.length?{childNodes:footer.map(textContent=>({nodeType:3,textContent}))}:null;
        if(selector==='form.chat-composer textarea')return value===undefined?null:{value};
        throw new Error('Unexpected global selection');
      },
    };
    return new Function('document',`return (${expression});`)(document);
  };
  return {observe,child,draft};
}

test('Herdr confirmation observation is closed when absent or pending',async()=>{
  const {observe}=await herdrConfirmationFixture();
  expect(observe()).toEqual({regions:0,choose:0,confirm:0,send:0,chooseDisabled:false,pending:false,errorPresent:false,error:'none',ownedChildDisconnected:false,moshFooter:false,draftMatches:false});
  expect(observe({regions:[{buttons:[{textContent:'Choose terminal destination',disabled:true}],statuses:['Waiting for the terminal response…']}]})).toMatchObject({regions:1,choose:1,confirm:0,chooseDisabled:true,pending:true,errorPresent:false,error:'none'});
});

test('Herdr confirmation observation classifies exact known regional copy without retaining errors',async()=>{
  const {english}=await import('../apps/client/src/i18n/en');
  const {observe}=await herdrConfirmationFixture();
  const categories=[['chatHerdrUnavailable','unavailable'],['chatTerminalStale','stale'],['chatTerminalInvalid','invalid'],['chatTerminalInvalidDraft','invalid'],['chatTerminalBusy','busy'],['chatTerminalInvalidReply','invalidReply'],['chatHerdrUncertain','uncertain']] as const;
  for(const [key,error] of categories)expect(observe({regions:[{alerts:[english[key]]}]})).toMatchObject({errorPresent:true,error});
  for(const privateError of ['private-error-path/token',english.chatTerminalBusy+' private-token',' '+english.chatTerminalStale]){
    const snapshot=observe({regions:[{alerts:[privateError]}]});
    expect(snapshot.error).toBe('other');expect(JSON.stringify(snapshot)).not.toContain(privateError);
  }
  expect(observe({regions:[{alerts:[english.chatHerdrUnavailable,english.chatHerdrUnavailable]}]}).error).toBe('other');
});

test('Herdr confirmation observation caps duplicates and retains only owned DOM comparisons',async()=>{
  const {observe,child,draft}=await herdrConfirmationFixture();
  const privateValue='/private/token/'+ 'secret'.repeat(20_000);
  const buttons=[{textContent:'Choose terminal destination',disabled:true},{textContent:'Confirm this destination',disabled:false},{textContent:'Send to terminal',disabled:false},{textContent:privateValue,disabled:true}];
  const snapshot=observe({regions:Array.from({length:20},()=>({buttons})),tabs:[{textContent:child,idle:true},{textContent:privateValue,idle:true}],footer:['Mosh',privateValue],value:draft});
  expect(snapshot).toEqual({regions:8,choose:8,confirm:8,send:8,chooseDisabled:true,pending:false,errorPresent:false,error:'none',ownedChildDisconnected:true,moshFooter:true,draftMatches:true});
  const serialized=JSON.stringify(snapshot);
  for(const value of [child,draft,privateValue,'secret','/private'])expect(serialized).not.toContain(value);
  expect(serialized.length).toBeLessThan(250);
  expect(observe({regions:[{buttons:[...buttons,{textContent:'Choose terminal destination',disabled:false}]}],tabs:[{textContent:child+'-other',idle:true}],footer:['Mosh-private'],value:draft+'-other'})).toMatchObject({chooseDisabled:false,ownedChildDisconnected:false,moshFooter:false,draftMatches:false});
});


test('native continuous finger observation rejects restarts, identity changes, untrusted events and early release',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-herdr-finger.js'),'utf8');
  const key='owned-finger-probe';
  function setup() {
    const callbacks=new Map<string,(event:Record<string,unknown>)=>void>();
    const canvas={contains:(target:unknown)=>target===screen,addEventListener:(name:string,fn:(event:Record<string,unknown>)=>void)=>callbacks.set(name,fn),
      removeEventListener:(name:string)=>callbacks.delete(name)};
    const screen={isConnected:true,textContent:'OLD490OLD491NEW512',closest:()=>canvas};
    const globalCallbacks=new Map<string,(event:Record<string,unknown>)=>void>();
    const window={addEventListener:(name:string,fn:(event:Record<string,unknown>)=>void)=>globalCallbacks.set(name,fn),
      removeEventListener:(name:string)=>globalCallbacks.delete(name)} as unknown as Record<string,{sample:()=>{row:number;newest:boolean;active:boolean;held:boolean;moves:number};dispose:()=>void}>;
    const install=new Function('window','ownedScreens',`${source};return ownedHerdrObserveFinger(window,${JSON.stringify(key)},ownedScreens);`);
    expect(install(window,[screen])).toBe(true);expect(install(window,[screen])).toBe(false);
    const event=(type:string,identifier=3,trusted=true)=>callbacks.get(type)!({type,isTrusted:trusted,target:screen,touches:type==='touchend'||type==='touchcancel'?[]:[{identifier}]});
    return {screen,window,event,sample:()=>window[key].sample(),dispose:()=>window[key].dispose(),callbacks};
  }
  const good=setup();expect(good.sample()).toMatchObject({row:490,newest:true,active:true,held:false,moves:0});
  good.event('touchstart');good.event('touchmove');good.screen.textContent='OLD480OLD481';
  expect(good.sample()).toMatchObject({row:480,newest:false,active:true,held:true,moves:1});
  good.event('touchmove');good.screen.textContent='OLD470OLD471';expect(good.sample().row).toBeLessThan(480);expect(good.sample().moves).toBe(2);
  good.event('touchend');expect(good.sample().active).toBe(false);
  good.dispose();expect(good.callbacks.size).toBe(0);
  for(const bad of ['restart','identity','untrusted','cancel','detached']) {
    const fixture=setup();fixture.event('touchstart');
    if(bad==='restart')fixture.event('touchstart');
    if(bad==='identity')fixture.event('touchmove',4);
    if(bad==='untrusted')fixture.event('touchmove',3,false);
    if(bad==='cancel')fixture.event('touchcancel');
    if(bad==='detached')fixture.screen.isConnected=false;
    expect(fixture.sample().active).toBe(false);fixture.dispose();expect(fixture.callbacks.size).toBe(0);
  }
});
test('shared Herdr native report requires the completed exact single case, not a skipped or substituted owner',()=>{
  const row='<testcase name="ownedSharedHerdrNavigationThroughRealUi" classname="app.lazysh.client.NativeWorkspaceTest" />';
  const report=`<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite>${row}</testsuite></testsuites>`;
  expect(validateSharedHerdrReport(report)).toEqual({nativeCase:'ownedSharedHerdrNavigationThroughRealUi',passed:1,failed:0,skipped:0});
  for(const invalid of ['',report.replace(row,''),report.replace(row,row+row),report.replace('ownedSharedHerdrNavigationThroughRealUi','otherOwner'),report.replace('app.lazysh.client.NativeWorkspaceTest','foreign.Case'),report.replace('</testsuite>','<skipped /></testsuite>'),report.replace('</testsuite>','<failure /></testsuite>'),report.replace('</testsuite>','<error /></testsuite>'),report.replace('failures="0"','failures="1"'),report.replace('</testsuites>',''),report.replace(row,`<!--${row}-->`),report.replace(row,`<![CDATA[${row}]]>`)])
    expect(()=>validateSharedHerdrReport(invalid)).toThrow('did not pass exactly once');
});
test('shared Herdr result rejects stale, duplicate, oversized and symlink report files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-herdr-report-')),path=join(directory,'TEST-owned.xml');
  const report='<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite><testcase name="ownedSharedHerdrNavigationThroughRealUi" classname="app.lazysh.client.NativeWorkspaceTest" /></testsuite></testsuites>';
  try {
    expect(await sharedHerdrReportIdentity(directory)).toBeUndefined();
    await writeFile(path,report);
    expect((await verifySharedHerdrResult(directory)).passed).toBe(1);
    await expect(verifySharedHerdrResult(directory,await sharedHerdrReportIdentity(directory))).rejects.toThrow('not refreshed');
    await writeFile(join(directory,'TEST-extra.xml'),report);
    await expect(verifySharedHerdrResult(directory)).rejects.toThrow('Expected one');
    await rm(join(directory,'TEST-extra.xml'));
    await writeFile(path,'x'.repeat(262145));
    await expect(verifySharedHerdrResult(directory)).rejects.toThrow('Invalid owned');
    await rm(path);await writeFile(join(directory,'private-target'),report);await symlink('private-target',path);
    await expect(verifySharedHerdrResult(directory)).rejects.toThrow('Invalid owned');
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('manual attachment receipt binds exact large valid-image dimensions and rejects private or malformed fields',()=>{
  const nonce='a'.repeat(32),valid={schemaVersion:1,nonce,bytes:462702,width:448,height:320,sha256:'b'.repeat(64)};
  expect(attachmentReceipt(JSON.stringify(valid),nonce)).toEqual(valid);
  for(const value of [null,[],{...valid,nonce:'c'.repeat(32)},{...valid,bytes:65536},{...valid,bytes:600*1024+1},{...valid,bytes:462702.1},{...valid,width:8193},{...valid,height:1},{...valid,sha256:'private-secret'},{...valid,extra:'private-secret'}])
    expect(()=>attachmentReceipt(JSON.stringify(value),nonce)).toThrow('Owned attachment receipt invalid');
  for(const text of ['private-secret','x'.repeat(1025)])expect(()=>attachmentReceipt(text,nonce)).toThrow('Owned attachment receipt invalid');
});

test('owned attachment readback detects changed content, inode, size and timestamps and rejects links',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-attachment-oracle-')),path=join(directory,'owned.png');
  try {
    await writeFile(path,'original owned bytes',{mode:0o600,flag:'wx'});
    const original=await attachmentIdentity(path);
    expect(await attachmentIdentity(path)).toEqual(original);
    await utimes(path,1,1);
    const timestampOnly=await attachmentIdentity(path);
    expect(timestampOnly.sha256).toBe(original.sha256);expect(timestampOnly.bytes).toBe(original.bytes);expect(timestampOnly.identity).not.toBe(original.identity);
    await writeFile(path,'rewritten owned bytes');
    const rewritten=await attachmentIdentity(path);
    expect(rewritten.sha256).not.toBe(original.sha256);expect(rewritten.bytes).not.toBe(original.bytes);expect(rewritten.identity).not.toBe(original.identity);
    await rename(path,join(directory,'original-kept'));await writeFile(path,'different inode');
    expect((await attachmentIdentity(path)).identity).not.toBe(original.identity);
    await symlink(path,join(directory,'link'));
    await expect(attachmentIdentity(join(directory,'link'))).rejects.toThrow();
    await expect(attachmentIdentity(directory)).rejects.toThrow('Owned attachment file invalid');
    await writeFile(path,Buffer.alloc(600*1024+1));
    await expect(attachmentIdentity(path)).rejects.toThrow('Owned attachment file invalid');
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('manual attachment native checkpoint is selected by the existing uncached SSH owner and admitted Mosh fixture',async()=>{
  const root=join(import.meta.dir,'..');
  const script=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8')).scripts['test:android-ssh'];
  expect(script).toBe('LAZYSH_ANDROID_UI_SSH=1 LAZYSH_ANDROID_UI_RECORDED=1 LAZYSH_ANDROID_UI_ATTACHMENTS=1 LAZYSH_ANDROID_UI_IME=1 LAZYSH_ANDROID_UI_DPAD=1 bun test ../../tests/android-ssh.test.ts ../../tests/android-ssh-host.test.ts');
  const scripts=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8')).scripts;
  expect(scripts['test:android']).toContain('app.lazysh.client.NativeWorkspaceTest#ownedMoshUploadsLargeClipboardImageThroughRealUi');
  const native=await readFile(join(root,'tests/android-ssh-host.test.ts'),'utf8');
  expect(native).toContain("test.skipIf(process.env.LAZYSH_ANDROID_UI_ATTACHMENTS!=='1')");
  expect(native).toContain('await androidSshAcceptance(undefined,undefined,false,false,false,false,true)');
  const support=await readFile(join(root,'tests/support/androidSsh.ts'),'utf8');
  expect(support).toContain('const moshBinary=(moshBackground || attachments)?');
  expect(support).toContain('privateTtyGroup:true,moshBinary,observeMoshBootstraps:true');
  expect(support).toContain("attachments?'ownedMoshUploadsLargeClipboardImageThroughRealUi'");
  expect(support).toContain("attachments?'-PlazyshAttachmentAcceptance=true'");
  expect(support).toContain('retainedPackages=!!herdr || attachments');
  expect(support).toContain("(herdr || attachments || dpad)?['-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true']");
  expect(support).toContain('(herdrMosh || attachments) && await readFile');
  const gradle=await readFile(join(root,'apps/client/src-tauri/gen/android/app/build.gradle.kts'),'utf8');
  expect(gradle).toContain('outputs/androidTest-results/attachment-ui');
  expect(gradle).toContain('lazyshAttachmentAcceptance');
});

test('background Mosh witness retains its failed stage and original error without publishing private values',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-mosh-diagnostic-'));
  const original=new Error('private owned witness error');
  let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});
  await writeFile(join(directory,'background-before'),'123 456\n');
  const observer=observeAndroidMoshBackground({directory,daemon:{async liveIdentity(){enter();throw original;}}});
  try {
    await entered;await observer.stop();
    const sample=observer.diagnostic();
    expect(sample).toEqual({schemaVersion:1,phase:'before-ownership',beforeValidated:false,beforeAck:false,afterValidated:false,outputValidated:false,afterAck:false,verified:false,stopped:true,failure:'witness-failure'});
    expect(JSON.stringify(sample)).not.toContain('private');expect(JSON.stringify(sample)).not.toContain(directory);
    let caught:unknown;try {observer.check();}catch(error){caught=error;}
    expect(caught).toBe(original);
    await expect(readFile(join(directory,'background-before-ack'))).rejects.toMatchObject({code:'ENOENT'});
    await observer.stop();expect(observer.diagnostic()).toEqual(sample);
  } finally {await observer.stop();await rm(directory,{recursive:true,force:true});}
},2000);

test('background Mosh document observations distinguish renderer state without retaining text or claiming transport identity',async()=>{
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/MoshBackgroundObservation.kt'),'utf8');
  const source=kotlin.match(/fun expression[\s\S]*?= """([\s\S]*?)"""/)![1];
  const name='owned private session',key='owned-key',token='owned-token';
  const expression=source.replaceAll('$key',JSON.stringify(key)).replaceAll('$token',JSON.stringify(token)).replaceAll('${JSONObject.quote(name)}',JSON.stringify(name));
  const evaluate=new Function('window','document',`return ${expression}`);
  const helper={readOnly:true,disabled:false,value:'private terminal input'},composer={value:'private draft'};
  let helpers:unknown[]=[helper],active:unknown=helper,connected=false,error=true,retained=true;
  const pane={querySelector:(selector:string)=>selector.includes('textarea')?composer:selector.includes('terminal-edit-review')?{}:null};
  const terminal={isConnected:true,closest:()=>pane,querySelectorAll:()=>helpers};
  const tab={querySelector:(selector:string)=>selector==='[role=tab]'?{textContent:name}:{classList:{contains:()=>!connected}}};
  const document={hasFocus:()=>true,get activeElement(){return active;},querySelector:(selector:string)=>selector==='.terminal-canvas'?terminal:selector==='.session-tab-active'?tab:selector==='.global-error'&&error?{}:null,querySelectorAll:()=>[terminal]};
  const sample=()=>evaluate({[key]:{token:retained?token:'stale',terminal}},document);
  expect(sample()).toEqual({retained:true,helperCount:'one',documentFocused:true,activeKind:'terminal',readOnly:true,disabled:false,composerPresent:true,composerEmpty:false,rendererConnected:false,globalError:true,unappliedEdit:true});
  connected=true;error=false;active=composer;retained=false;helpers=[];
  expect(sample()).toMatchObject({retained:false,helperCount:'zero',activeKind:'composer',readOnly:null,disabled:null,rendererConnected:true,globalError:false});
  helpers=[helper,helper];active={matches:()=>true};
  expect(sample()).toMatchObject({helperCount:'many',activeKind:'control',readOnly:null});
  expect(JSON.stringify(sample())).not.toContain('private');expect(JSON.stringify(sample())).not.toContain(name);
});


test('board Setup observations cross native JSON callbacks as strict booleans or null',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const script=source.match(/val expanded = evaluate\(scenario, """([\s\S]*?)"""/)!;
  expect(script).not.toBeNull();
  const selector='.agent-panel:not([hidden]) > .tool-bar button[aria-expanded]';
  const expression=script[1].replaceAll('${JSONObject.quote(setup)}',JSON.stringify(selector));
  const callback=(attributes:string[])=>JSON.stringify(new Function('document',`return (${expression});`)({querySelectorAll:(value:string)=>{
    expect(value).toBe(selector);return attributes.map(attribute=>({getAttribute:()=>attribute}));
  }}));
  expect(callback(['false'])).toBe('false');expect(callback(['true'])).toBe('true');
  for(const attributes of [[],['false','true'],['private-unexpected-value'],['']])expect(callback(attributes)).toBe('null');
});

test('whole-value native clipboard paste selects existing text before paste within its original budget',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=source.match(/private fun pasteOwnedText\([\s\S]*?\n    @Test/)![0];
  const actions=Array.from(body.matchAll(/(?:withKeyCode\(KeyEvent\.|pressKey\(KeyEvent\.)(KEYCODE_[A-Z_]+)/g),match=>match[1]);
  expect(actions).toEqual(['KEYCODE_A','KEYCODE_PASTE']);
  const select=body.indexOf('withKeyCode(KeyEvent.KEYCODE_A)'),paste=body.indexOf('pressKey(KeyEvent.KEYCODE_PASTE)');
  expect(body.slice(select,paste)).toContain('withCtrlPressed(true)');
  expect(body.slice(select,paste)).toContain('requireTime()');
  expect(body).toContain('TimeUnit.SECONDS.toNanos(5)');
  expect(body).toContain('?.value===${JSONObject.quote(text)}');
});

async function herdrVisualFixture() {
  const directory=join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest');
  const source=await readFile(join(directory,'java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const script=source.match(/val visualObservation = """([\s\S]*?)"""/)![1];
  const viewport=await readFile(join(directory,'assets/owned-keyboard-viewport.js'),'utf8');
  const rectangle=(left:number,top:number,right:number,bottom:number)=>({left,top,right,bottom,width:right-left,height:bottom-top});
  const labels=Array.from({length:3},(_,i)=>({bounds:rectangle(10,10+i*30,80,30+i*30),glyphs:[] as object[],contains:(hit:unknown)=>(hit as {ownedLabel?:number})?.ownedLabel===i,textContent:'private terminal text'}));
  labels.forEach(label=>label.glyphs=[label.bounds]);
  const group={getAttribute:()=>labels[1].textContent,querySelector:(selector:string)=>selector===':scope > h4'?labels[1]:null};
  const card={closest:(selector:string)=>selector==='section[aria-label]'?group:null,getClientRects:()=>[{}],getBoundingClientRect:()=>rectangle(0,0,200,110),contains:(_hit:unknown)=>false,
    querySelector:(selector:string)=>labels[['strong',':scope > small','span > small'].indexOf(selector)]};
  const state={cards:[card],blockers:[] as object[],hit:undefined as object|undefined,live:true};
  const window={visualViewport:{offsetLeft:0,offsetTop:0,width:411,height:659,scale:1}};
  const document={querySelectorAll:(selector:string)=>selector.includes('.herdr-navigation-row')?state.cards:state.blockers,
    elementFromPoint:(_x:number,y:number)=>state.hit??labels.find(label=>y>=label.bounds.top&&y<=label.bounds.bottom),
    createRange:()=>{let selected=labels[0];return {selectNodeContents:(label:typeof selected)=>{selected=label;},getClientRects:()=>selected.glyphs,getBoundingClientRect:()=>selected.bounds};}};
  return {labels,group,card,state,window,observe:()=>new Function('document','window',`return (${script.replace('$viewportOracle',viewport).replace('$liveHerdr',String(state.live))});`)(document,window)};
}

test('Herdr visual failure observations distinguish viewport and glyph-hit clauses without changing admission',async()=>{
  const f=await herdrVisualFixture();
  expect(f.observe()).toMatchObject({state:'observed',liveReady:true,cards:1,cardShown:true,viewportReady:true,blockers:0});
  f.state.hit=f.card;
  expect(f.observe().labels[0]).toMatchObject({present:true,glyphs:1,truncated:false,hit:'card',failedRect:[10,10,80,30]});
  f.state.live=false;f.labels[0].bounds.left=-10;
  expect(f.observe()).toMatchObject({liveReady:false,viewportReady:false});
  f.state.cards=[];expect(f.observe()).toMatchObject({cards:0,cardShown:false,cardRect:null,viewportReady:false});
  const wrongGroup=await herdrVisualFixture();expect(wrongGroup.observe().viewportReady).toBe(true);
  wrongGroup.group.getAttribute=()=> 'different status';
  expect(wrongGroup.observe()).toMatchObject({state:'observed',viewportReady:false});expect(wrongGroup.observe().labels[1].present).toBe(false);
});

test('Herdr visual observations bound rectangles and counts and discard private DOM and exceptions',async()=>{
  const f=await herdrVisualFixture();
  f.state.hit={id:'private-session-id',textContent:'private output'};f.state.cards=Array(80).fill(f.card);
  f.state.blockers=Array(80).fill({getClientRects:()=>[{}]});f.labels[0].glyphs=Array(80).fill(f.labels[0].bounds);
  f.labels[0].bounds.left=-1e9;f.labels[1].bounds.right=Infinity;
  const sample=f.observe();
  expect(sample).toMatchObject({cards:8,blockers:8,viewportReady:false});
  expect(sample.labels[0]).toMatchObject({rect:[-65535,10,80,30],glyphs:64,truncated:true,hit:'other'});
  expect(sample.labels[1].rect).toEqual([10,40,null,60]);
  expect(JSON.stringify(sample)).not.toMatch(/private|session-id|terminal text/);expect(JSON.stringify(sample).length).toBeLessThan(2048);
  f.card.getBoundingClientRect=()=>{throw new Error('private host/path');};
  expect(f.observe()).toEqual({state:'unavailable'});
});


async function companionReadinessFixture(expected='Update companion',expectedOutcome='installed') {
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const source=kotlin.match(/val companionReadinessObservation = """([\s\S]*?)"""/);
  expect(source).not.toBeNull();
  const install=kotlin.slice(kotlin.indexOf('fun verifyCompanionInstallation()'));
  const scope=install.match(/val panel = "([^"]+)"/)![1],direct=scope+' > .tool-bar > button';
  const element=kotlin.match(/private fun workspaceElementVisible\([^\n]* = """([\s\S]*?)"""/)![1];
  const visible=(selector:string,touchable=false)=>element.replaceAll('${JSONObject.quote(selector)}',JSON.stringify(selector)).replaceAll('$touchable',String(touchable));
  const button=kotlin.match(/private fun workspaceButtonVisible\([^\n]* = """([\s\S]*?)"""/)![1]
    .replaceAll('${JSONObject.quote("$scope button")}',JSON.stringify(scope+' button')).replaceAll('${JSONObject.quote(text)}',JSON.stringify(expected));
  const allowed=(name:string)=>JSON.parse('['+install.match(new RegExp('val '+name+' = setOf\\(([^)]*)\\)'))![1]+']');
  const expression=source![1].replaceAll('${JSONObject.quote(panel)}',JSON.stringify(scope))
    .replaceAll('${JSONObject.quote("$panel > .tool-bar > button")}',JSON.stringify(direct))
    .replaceAll('${workspaceButtonVisible(panel, action)}',button)
    .replaceAll('${workspaceElementVisible(panel)}',visible(scope))
    .replaceAll('${workspaceElementVisible("$panel > .tool-bar > button", true)}',visible(direct,true))
    .replaceAll('${JSONObject.quote(action)}',JSON.stringify(expected))
    .replaceAll('${JSONObject.quote(if(reused) "installed" else "idle")}',JSON.stringify(expectedOutcome))
    .replaceAll('${JSONArray(phases)}',JSON.stringify(allowed('phases')))
    .replaceAll('${JSONArray(failures)}',JSON.stringify(allowed('failures')));
  const state={present:true,open:true,hidden:false,disabled:false,parentError:false,count:1,label:'Update companion',outcome:'installed',phase:'cleaningUp',failure:'none',hit:true};
  const bounds=()=>({left:10,top:10,right:110,bottom:40,width:100,height:30});
  const action={get textContent(){return state.label;},get disabled(){return state.disabled;},
    getClientRects:()=>state.open&&!state.hidden?[bounds()]:[],
    getBoundingClientRect:()=>state.open&&!state.hidden?bounds():{left:0,top:0,right:0,bottom:0,width:0,height:0},
    closest:()=>action,contains:(value:unknown)=>value===action};
  const panel={get open(){return state.open;},getClientRects:()=>state.hidden?[]:[bounds()],getBoundingClientRect:bounds,
    getAttribute:(name:string)=>({'data-install-outcome':state.outcome,'data-install-phase':state.phase,'data-install-failure':state.failure}[name]),
    closest:()=>({querySelector:()=>state.parentError?Object.defineProperty({},'textContent',{get(){throw new Error('Private parent text read');}}):null})};
  const document={querySelector:(selector:string)=>!state.present?null:selector===scope?panel:selector===direct&&state.count?action:null,
    querySelectorAll:(selector:string)=>state.present&&(selector===direct||selector===scope+' button')?Array(state.count).fill(action):[],
    elementFromPoint:()=>state.hit?action:{closest:()=>null}};
  const observe=()=>new Function('document','getComputedStyle','innerWidth','innerHeight',`return (${expression});`)(document,()=>({visibility:state.hidden?'hidden':'visible'}),400,800);
  return {state,observe};
}

test('companion readiness observation identifies the exact unchanged action predicates',async()=>{
  const {state,observe}=await companionReadinessFixture();
  expect(observe()).toEqual({expectedActionVisible:true,matchingExpectedActionEnabled:true,outcomeExpected:true,panelPresent:true,panelVisible:true,detailsOpen:true,directActionPresent:true,directActionVisible:true,directActionEnabled:true,labelKind:'update',outcome:'installed',phase:'cleaningUp',failure:'none',parentAgentErrorPresent:false});
  state.label='Install companion';state.parentError=true;
  expect(observe()).toMatchObject({expectedActionVisible:false,matchingExpectedActionEnabled:false,outcomeExpected:true,labelKind:'install',parentAgentErrorPresent:true});
  state.label=' Update companion ';
  expect(observe()).toMatchObject({expectedActionVisible:true,matchingExpectedActionEnabled:false,labelKind:'other'});
  state.label='Update companion';state.outcome='idle';
  expect(observe()).toMatchObject({expectedActionVisible:true,matchingExpectedActionEnabled:true,outcomeExpected:false,outcome:'idle'});
});

test('companion readiness observation separates collapsed, occluded, missing and duplicate actions',async()=>{
  const {state,observe}=await companionReadinessFixture();
  state.open=false;expect(observe()).toMatchObject({panelVisible:true,detailsOpen:false,expectedActionVisible:false,directActionVisible:false});
  state.open=true;state.hit=false;expect(observe()).toMatchObject({detailsOpen:true,expectedActionVisible:false,directActionVisible:false});
  state.hit=true;state.hidden=true;expect(observe()).toMatchObject({panelVisible:false,directActionVisible:false});
  state.hidden=false;state.count=0;expect(observe()).toMatchObject({directActionPresent:false,directActionEnabled:false,labelKind:'other'});
  state.count=2;expect(observe()).toMatchObject({expectedActionVisible:false,matchingExpectedActionEnabled:true,directActionPresent:true,directActionVisible:false,labelKind:'other'});
  state.present=false;expect(observe()).toMatchObject({panelPresent:false,panelVisible:false,outcome:'unavailable',phase:'unavailable',failure:'unavailable'});
});

test('companion readiness observation retains only closed enums and booleans',async()=>{
  const {state,observe}=await companionReadinessFixture('Install companion','idle');
  state.label='Install companion';state.outcome='idle';
  expect(observe()).toMatchObject({expectedActionVisible:true,matchingExpectedActionEnabled:true,outcomeExpected:true,labelKind:'install'});
  state.label='Installing…';state.disabled=true;
  expect(observe()).toMatchObject({labelKind:'busy',directActionEnabled:false,matchingExpectedActionEnabled:false});
  const secret='private-key-path-token-and-error';
  for(const key of ['label','outcome','phase','failure'] as const)state[key]=secret;
  state.parentError=true;
  const sample=observe();
  expect(sample).toMatchObject({labelKind:'other',outcome:'unavailable',phase:'unavailable',failure:'unavailable',parentAgentErrorPresent:true});
  expect(JSON.stringify(sample)).not.toContain(secret);
  expect(Object.values(sample).every(value=>typeof value==='boolean'||['other','unavailable'].includes(value as string))).toBe(true);
});


test.skipIf(process.platform!=='linux')('raw receiver identity checker rejects live foreign, substituted and falsely terminal observations',async()=>{
  const current=(await identity(process.pid))!;
  const hash=createHash('sha256').update(await readFile(`/proc/${process.pid}/exe`)).digest('hex');
  expect(await checkRawReceiverIdentity(current,undefined,process.pid,hash)).toEqual(current);
  await expect(checkRawReceiverIdentity(current,current,process.pid,'0'.repeat(64))).rejects.toThrow('image differs');
  await expect(checkRawReceiverIdentity(current,{...current,start:'0'},process.pid,hash)).rejects.toThrow('replaced');
  await expect(checkRawReceiverIdentity(current,{...current,pid:current.pid+1},process.pid,hash)).rejects.toThrow('replaced');
  await expect(checkRawReceiverIdentity(current,current,2147483647,hash)).rejects.toThrow('identity unavailable');
  await expect(checkRawReceiverIdentity(undefined,undefined,process.pid,hash)).rejects.toThrow('not observed');
  // A missing/terminal first sample cannot excuse an independently still-live
  // original. Every purported terminal state requires the real fresh readback.
  for(const state of ['Z','X']) {
    await expect(checkRawReceiverIdentity({...current,state},current,process.pid,hash)).rejects.toThrow('identity unavailable');
    await expect(checkRawReceiverIdentity({...current,state},undefined,process.pid,hash)).rejects.toThrow('not observed');
  }
  await expect(checkRawReceiverIdentity(undefined,current,process.pid,hash)).rejects.toThrow('identity unavailable');
});

test.skipIf(process.platform!=='linux')('raw receiver checker preserves exact filesystem errors and rejects missing executable for a still-live receiver',async()=>{
  const current=(await identity(process.pid))!,path=`/proc/${process.pid}/exe`;
  const original=fileSystem.readFile;
  const hash=createHash('sha256').update(await original(path)).digest('hex');
  for(const code of ['EACCES','EIO',undefined,'ENOENT','ESRCH']) {
    const failure=Object.assign(new Error('private-receiver-read-error'),{code});
    const read=spyOn(fileSystem,'readFile').mockImplementation((...args:Parameters<typeof original>)=>{
      if(args[0]===path)return Promise.reject(failure);
      return original(...args);
    });
    try {
      const result=await checkRawReceiverIdentity(current,current,process.pid,hash).catch(error=>error);
      if(code==='ENOENT' || code==='ESRCH')expect(result.message).toBe('Owned IME receiver identity unavailable');
      else expect(result).toBe(failure);
      expect((await identity(process.pid))?.start).toBe(current.start);
    } finally {read.mockRestore();}
  }
  expect(await checkRawReceiverIdentity(current,current,process.pid,hash)).toEqual(current);
});

test.skipIf(process.platform!=='linux')('raw receiver checker rejects an observed terminal replacement before any later disappearance',async()=>{
  const current=(await identity(process.pid))!;
  const hash=createHash('sha256').update(await readFile(`/proc/${process.pid}/exe`)).digest('hex');
  for(const state of ['Z','X']) {
    let reads=0;
    const sample=spyOn(ownedProcesses,'identity').mockImplementation(async()=>++reads===1?{...current,start:'0',state}:undefined);
    try {
      await expect(checkRawReceiverIdentity(current,current,process.pid,hash)).rejects.toThrow('replaced');
      expect(reads).toBe(1);
    } finally {sample.mockRestore();}
  }
  expect((await identity(process.pid))?.start).toBe(current.start);
});

test.skipIf(typeof process.getuid!=='function')('IME failure wire snapshot exports only bounded fixed-stream comparisons',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-ime-wire-')),path=join(directory,'received-bytes');
  const nonce='0123456789abcdef'.repeat(2),expected=Buffer.from(`${IME_TRANSACTION_WIRE}\x1b[13;2u\r\x1b[13;2uowned-current-${nonce}\r\x1b[13;2u`);
  const samples=[Buffer.alloc(0),expected.subarray(0,7),expected,Buffer.concat([expected,Buffer.from('extra-private')]),Buffer.from(`${IME_TRANSACTION_WIRE}owned-old-${nonce}`),Buffer.from('private-payload')];
  try {
    for(const bytes of samples) {
      await writeFile(path,bytes,{mode:0o600});let prefix=0;
      while(prefix<Math.min(bytes.length,expected.length)&&bytes[prefix]===expected[prefix])prefix++;
      const result=await observeImeReceiverWire(path,nonce);
      expect(result).toEqual({state:'available',byteLength:bytes.length,exactExpectedMatch:bytes.equals(expected),fixedPrefixMatchLength:prefix});
      expect(Object.values(result).every(value=>typeof value==='number'||typeof value==='boolean'||value==='available')).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/private|owned-current|01234567|received-bytes|sha256/);
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

test.skipIf(typeof process.getuid!=='function')('protected raw reader rejects unsafe files and IME observations redact read failures',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-ime-file-')),path=join(directory,'received-bytes'),nonce='0'.repeat(32);
  try {
    await writeFile(path,'fixed',{mode:0o600});expect(await readRawReceiverBytes(path)).toEqual(Buffer.from('fixed'));
    await symlink(path,join(directory,'link'));
    for(const unsafe of [directory,join(directory,'missing'),join(directory,'link')]) {
      await expect(readRawReceiverBytes(unsafe)).rejects.toThrow();
      expect(await observeImeReceiverWire(unsafe,nonce)).toEqual({state:'unavailable'});
    }
    expect(await observeImeReceiverWire(path,'private-invalid')).toEqual({state:'unavailable'});
    const uid=process.getuid!(),owner=spyOn(process,'getuid').mockReturnValue(uid+1);
    try {await expect(readRawReceiverBytes(path)).rejects.toThrow('Owned IME receiver output invalid');}
    finally {owner.mockRestore();}
    await writeFile(path,Buffer.alloc(16385));
    await expect(readRawReceiverBytes(path)).rejects.toThrow('Owned IME receiver output invalid');
    expect(await observeImeReceiverWire(path,nonce)).toEqual({state:'unavailable'});
    await writeFile(path,Buffer.alloc(16384));expect((await readRawReceiverBytes(path)).length).toBe(16384);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test.skipIf(process.platform!=='linux')('protected raw reader rejects a FIFO without waiting for a writer',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-ime-fifo-')),path=join(directory,'received-bytes');
  try {
    await new OwnedProcess('mkfifo',[path]).finish('owned nonexecuting FIFO fixture',2000);
    await expect(readRawReceiverBytes(path)).rejects.toThrow('Owned IME receiver output invalid');
  } finally {await rm(directory,{recursive:true,force:true});}
},3000);

for(const change of ['changed','short'] as const)test.skipIf(typeof process.getuid!=='function')(`protected raw reader closes its file after a ${change} read and exports no guessed bytes`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-ime-race-')),path=join(directory,'received-bytes');
  const original=fileSystem.open;let observed:Awaited<ReturnType<typeof original>>|undefined;const readSizes:number[]=[];
  const opening=spyOn(fileSystem,'open').mockImplementation(async(...args:Parameters<typeof original>)=>{
    const file=await original(...args);observed=file;const read=file.read.bind(file);
    Object.defineProperty(file,'read',{value:async(buffer:Buffer,offset:number,length:number,position:number)=>{
      const result=await read(buffer,offset,length,position);readSizes.push(result.bytesRead);
      if(change==='changed')await writeFile(path,'different size');
      return change==='short'?{...result,bytesRead:result.bytesRead-1}:result;
    }});return file;
  });
  try {
    await writeFile(path,'fixed',{mode:0o600});
    await expect(readRawReceiverBytes(path)).rejects.toThrow('Owned IME receiver output changed');
    expect(observed!.fd).toBe(-1);
    await writeFile(path,'fixed');
    expect(await observeImeReceiverWire(path,'0'.repeat(32))).toEqual({state:'unavailable'});expect(observed!.fd).toBe(-1);
    expect(readSizes).toEqual([5,5]);
  } finally {opening.mockRestore();await rm(directory,{recursive:true,force:true});}
});

test.skipIf(typeof process.getuid!=='function')('actual Android failure handler keeps its original error and limits wire observations to IME',async()=>{
  const source=await readFile(new URL('./support/androidSsh.ts',import.meta.url),'utf8');
  const start=source.indexOf('  } catch(error) {\n    primary=true;',source.indexOf('export async function androidSshAcceptance'));
  const end=source.indexOf('  } finally {\n    await moshWitness?.stop();',start);
  expect(start>0 && end>start).toBe(true);
  const body=source.slice(start+'  } catch(error) {'.length,end);
  const names=['herdr','tmux','sharedHerdr','moshWitness','navigationScreenshots','root','dpad','ime','companion','attachments','moshBackground','deniedNotification','crashes','observeImeReceiverWire','imeDirectory','fixture','hostAdbServerIdentity','adb','serial','hostServerBefore','packageExitInfo','emulatorContinuity','reverse','retainedPackages','ownedAndroidPackagePresence','before','keyboard','timing','gradleFailureClasses','reportInstrumentationFailures','gradle','recorded','compareEmulatorContinuity','compareHostAdbServer','mkdir','writeFile','join'];
  const compiled=new Bun.Transpiler({loader:'ts'}).transformSync(`async function run(context){const {${names.join(',')}}=context;let primary=false;try{throw context.failure;}catch(error){${body}}}`);
  const run=Function(compiled+';return run;')() as (context:Record<string,unknown>)=>Promise<void>;
  const directory=await mkdtemp(join(tmpdir(),'lazysh-ime-handler-')),nonce='0'.repeat(32),imeDirectory=join(directory,'ime'),wire=Buffer.from(`${IME_TRANSACTION_WIRE}\x1b[13;2u\r\x1b[13;2uowned-current-${nonce}\r\x1b[13;2u`);
  const logger=spyOn(console,'error').mockImplementation(()=>{}),reported:string[]=[];
  try {
    await mkdir(imeDirectory);await writeFile(join(imeDirectory,'received-bytes'),wire,{mode:0o600});
    for(const mode of ['available','missing','write-failure','observer-failure','non-ime']) {
      const root=join(directory,mode),failure=new Error('private-primary'),ime=mode!=='non-ime';let observations=0;
      const context={root,recorded:false,imeDirectory:mode==='missing'?join(directory,'absent'):imeDirectory,ime,fixture:{nonce,port:1},failure,mkdir,join,
        observeImeReceiverWire:async(path:string,value:string)=>{observations++;if(mode==='observer-failure')throw new Error('private-observer');return observeImeReceiverWire(path,value);},
        hostAdbServerIdentity:async()=>({}),packageExitInfo:async()=>({}),emulatorContinuity:async()=>({}),
        timing:{gradleStartMs:0},gradleFailureClasses:()=>({}),reportInstrumentationFailures:async(results:string)=>{reported.push(results);},compareEmulatorContinuity:()=>({}),compareHostAdbServer:()=> 'same',
        writeFile:async(...args:Parameters<typeof writeFile>)=>{if(mode==='write-failure')throw new Error('private-receipt');return writeFile(...args);}};
      expect(await run(context).catch(error=>error)).toBe(failure);expect(observations).toBe(ime?1:0);
      // The failing case is named from this mode's own results directory, before any observation that could itself fail.
      expect(reported.splice(0)).toEqual([join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results',ime?'ssh-ime-ui':'ssh-ui')]);
      if(['write-failure','observer-failure'].includes(mode))continue;
      const receipt=JSON.parse(await readFile(join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results',ime?'ssh-ime-ui':'ssh-ui','package-exit.json'),'utf8'));
      if(mode==='non-ime')expect(Object.hasOwn(receipt,'imeWire')).toBe(false);
      else expect(receipt.imeWire).toEqual(mode==='missing'?{state:'unavailable'}:{state:'available',byteLength:wire.length,exactExpectedMatch:true,fixedPrefixMatchLength:wire.length});
      expect(JSON.stringify(receipt)).not.toMatch(/private|owned-current|00000000|received-bytes/);
    }
    expect(logger.mock.calls.every(call=>call.length===1&&call[0]==='Owned Android SSH exit diagnostics unavailable')).toBe(true);
  } finally {logger.mockRestore();await rm(directory,{recursive:true,force:true});}
});

test('native soft Enter observer filters foreign targets, settles after the Enter key press, records closed event facts and retires listeners',async()=>{
  const path=join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt');
  const native=await readFile(path,'utf8'),body=native.split('fun commitOwnedLineBreak(')[1].split('var primary: Throwable? = null\n        try {\n            toolbarPreferences()')[0];
  const source=body.split('val installed = evaluate(scenario, """')[1].split('""")')[0].replaceAll('$key',JSON.stringify('owned'));
  const area={isConnected:true},handlers=new Map<string,(event:any)=>void>();
  const document={activeElement:area,querySelectorAll:()=>[area],addEventListener:(type:string,fn:(event:any)=>void)=>handlers.set(type,fn),removeEventListener:(type:string,fn:(event:any)=>void)=>{if(handlers.get(type)===fn)handlers.delete(type);}};
  const window:Record<string,any>={};expect(new Function('document','window',`return (${source})`)(document,window)).toBe(true);
  const foreign={target:{},get type(){throw new Error('foreign event read');}};expect(()=>handlers.get('input')!(foreign)).not.toThrow();
  handlers.get('keydown')!({target:area,type:'keydown',key:'Unidentified',keyCode:229,isTrusted:true,isComposing:false});
  expect(window.owned.settled).toBe(false);
  handlers.get('keydown')!({target:area,type:'keydown',key:'Enter',isTrusted:true,isComposing:false});
  handlers.get('input')!({target:area,type:'input',inputType:'insertLineBreak',isTrusted:true,isComposing:false,data:'private'});
  expect(window.owned.settled).toBe(false);await new Promise(resolve=>setTimeout(resolve,0));expect(window.owned.settled).toBe(true);
  const result=window.owned.stop();expect(result).toEqual({overflow:false,original:true,events:[{kind:'other-key',trusted:true,composing:false},
    {kind:'enter',trusted:true,composing:false},{kind:'line-break',trusted:true,composing:false}]});
  expect(JSON.stringify(result)).not.toContain('private');expect(handlers.size).toBe(0);expect(window.owned).toBeUndefined();
});

test('owned SSH IME wire oracle rejects replay, lost erasure, stale commits and duplicated current marker',()=>{
  const nonce='0123456789abcdef'.repeat(2),current=`owned-current-${nonce}`;
  const expected=Buffer.from(`${IME_TRANSACTION_WIRE}\x1b[13;2u\r\x1b[13;2u${current}\r\x1b[13;2u`);
  expect(()=>verifyImeReceiverBytes(expected,nonce)).not.toThrow();
  for(const bytes of [Buffer.alloc(0),Buffer.from(`thethe${current}`),Buffer.from(`therethe${current}`),
    Buffer.from(`${IME_TRANSACTION_WIRE}owned-old-${nonce}${current}`),Buffer.concat([expected,Buffer.from(current)]),
    Buffer.from(`there\x7f\x7fthethe${current}`),Buffer.from(`there\x7fthe${current}`),
    Buffer.from(`${IME_TRANSACTION_WIRE}\x1b[13;2u\r\r\x1b[13;2u${current}\r\x1b[13;2u`),
    Buffer.from(`${IME_TRANSACTION_WIRE}\x1b[13;2u\r\x1b[13;2uowned-preedit-${nonce}${current}\r\x1b[13;2u`),
    Buffer.from(`${IME_TRANSACTION_WIRE}\x1b[13;2u\x1b[13;2u\r\x1b[13;2u${current}\r\x1b[13;2u`),
    expected.subarray(0,expected.length-1),Buffer.concat([expected,Buffer.from('\r')]),
    // SwiftKey-shaped edits: a skipped Backspace after the toolbar key, a lost autocorrect erase, a lost or repeated word.
    Buffer.from(expected.toString('latin1').replace('\x1b\x7f','\x1b'),'latin1'),Buffer.from(expected.toString('latin1').replace('\x7f\x7f\x7f\x7ftan','\x7f\x7ftan'),'latin1'),
    Buffer.from(expected.toString('latin1').replace('ten ','ten ten '),'latin1'),Buffer.from(expected.toString('latin1').replace('swipe ',''),'latin1'),
    Buffer.from(expected.toString('latin1').replace('owned ','own'),'latin1'),
    Buffer.from(expected.toString('latin1').replace('web ','webweb '),'latin1'),Buffer.from(expected.toString('latin1').replace('web ','we'),'latin1')]) {
    expect(()=>verifyImeReceiverBytes(bytes,nonce)).toThrow('Owned IME receiver bytes differ');
  }
  expect(()=>verifyImeReceiverBytes(expected,'private-invalid')).toThrow('Owned IME nonce invalid');
  expect(()=>verifyImeReceiverBytes(undefined as never,'private-invalid')).toThrow('Owned IME nonce invalid');
  // Escape is a key, not text: the line a shell holds after these bytes is what the user typed, once and in order.
  let visible='';for(const byte of Buffer.from(IME_TRANSACTION_WIRE))visible=byte===127?visible.slice(0,-1):byte===27?visible:visible+String.fromCharCode(byte);
  expect(visible).toBe('thetheowned swipe tanweb ');
});

test('packaged SSH IME case uses ordinary native routing, a separate report, and no harness navigation',async()=>{
  const root=join(import.meta.dir,'..'),scripts=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8')).scripts;
  expect(scripts['test:android-ssh']).toContain('LAZYSH_ANDROID_UI_IME=1');
  expect(scripts['test:android']).toContain('NativeWorkspaceTest#ownedSshImeTransactionsThroughRealUi');
  const native=await readFile(join(root,'tests/android-ssh-host.test.ts'),'utf8');
  expect(native).toContain("test.skipIf(process.env.LAZYSH_ANDROID_UI_IME!=='1')");
  expect(native).toContain('await androidSshAcceptance(undefined,undefined,false,false,false,false,false,true)');
  const support=await readFile(join(root,'tests/support/androidSsh.ts'),'utf8');
  expect(support).toContain("rawInput?{privateTtyGroup:true,ownedReceiverRoot:true}");
  expect(support).toContain("ime?'-PlazyshSshImeAcceptance=true'");
  expect(support).toContain("ime?'ownedSshImeTransactionsThroughRealUi'");
  const gradle=await readFile(join(root,'apps/client/src-tauri/gen/android/app/build.gradle.kts'),'utf8');
  expect(gradle).toContain('outputs/androidTest-results/ssh-ime-ui');
  expect(gradle).toContain('"lazyshSshAcceptance","lazyshRecordedConversationAcceptance","lazyshSshImeAcceptance","lazyshSshDpadAcceptance","lazyshAttachmentAcceptance"');
  const kotlin=await readFile(join(root,'apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('private fun verifySshImeTransactions(')[1].split('private class OwnedImeControl(')[0];
  for(const forbidden of ['loadUrl(', 'loadData', 'ownedIme.', 'dispatchEvent(', 'terminal.input('])expect(body).not.toContain(forbidden);
  expect(/\.value\s*=(?!=)/.test(body)).toBe(false);
  expect(body).toContain('ime.restore()');expect(body).toContain('ime.call("old")');expect(body).toContain('ime.call("current")');
  const setup=kotlin.split('private inner class OwnedRawSshInput(')[1].split('private fun verifySshImeTransactions(')[0];
  expect(setup).toContain('assertSame("Packaged WebView must remain original"');
  for(const forbidden of ['loadUrl(', 'loadData', 'dispatchEvent(', 'terminal.input('])expect(setup).not.toContain(forbidden);
});


test('D-pad receipt and wire oracle reject malformed counts, stale/reordered arrows and repeats after the stopped snapshot',()=>{
  const nonce='0123456789abcdef'.repeat(2),row={schemaVersion:1,nonce,up:4,left:2,down:3,right:2};
  const counts=dpadReceipt(JSON.stringify(row),nonce),wire=Buffer.from('\x1b[A'.repeat(4)+'\x1b[D'.repeat(2)+'\x1b[B'.repeat(3)+'\x1b[C'.repeat(2)+`owned-dpad-${nonce}`);
  expect(counts).toEqual([4,2,3,2]);expect(()=>verifyDpadReceiverBytes(wire,nonce,counts)).not.toThrow();
  for(const invalid of [{...row,up:2},{...row,left:33},{...row,right:'2'},{...row,down:2.5},{...row,extra:'private text'},{...row,nonce:'0'.repeat(32)}])
    expect(()=>dpadReceipt(JSON.stringify(invalid),nonce)).toThrow('Owned D-pad receipt invalid');
  for(const invalid of [Buffer.concat([wire,Buffer.from('\x1b[C')]),Buffer.from(wire.toString().replace('owned-dpad','\x1b[Cowned-dpad')),
    Buffer.from(wire.toString().replace('\x1b[D','\x1b[B')),Buffer.from(wire.toString().replace('owned-dpad','\x1b[Aowned-dpad')),Buffer.from('owned-dpad-'+nonce)])
    expect(()=>verifyDpadReceiverBytes(invalid,nonce,counts)).toThrow('Owned D-pad receiver bytes differ');
});

test('native D-pad routing preserves default isolation and the packaged/raw-SSH ownership path',async()=>{
  const root=join(import.meta.dir,'..'),scripts=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8')).scripts;
  expect(scripts['test:android-ssh']).toContain('LAZYSH_ANDROID_UI_DPAD=1');
  expect(scripts['test:android']).toContain('NativeWorkspaceTest#ownedSshDpadPanThroughRealUi');
  const native=await readFile(join(root,'tests/android-ssh-host.test.ts'),'utf8');expect(native).toContain("test.skipIf(process.env.LAZYSH_ANDROID_UI_DPAD!=='1')");
  expect(native).toContain('androidSshAcceptance(undefined,undefined,false,false,false,false,false,false,true)');
  const support=await readFile(join(root,'tests/support/androidSsh.ts'),'utf8');
  expect(support).toContain("dpad?'-PlazyshSshDpadAcceptance=true'");expect(support).toContain('retainedPackages=!!herdr || attachments || dpad');
  expect(support).toContain("const bytes=await readRawReceiverBytes(join(imeDirectory,'received-bytes'))");
  expect(support).toContain('verifyDpadReceiverBytes(bytes,fixture.nonce,counts)');
  const gradle=await readFile(join(root,'apps/client/src-tauri/gen/android/app/build.gradle.kts'),'utf8');expect(gradle).toContain('outputs/androidTest-results/ssh-dpad-ui');
  const kotlin=await readFile(join(root,'apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('private fun verifySshDpadPan(')[1].split('private inner class OwnedRawSshInput(')[0];
  for(const forbidden of ['loadUrl(', 'loadData', 'dispatchEvent(', 'terminal.input('])expect(body).not.toContain(forbidden);
  expect(body).toContain('MotionEvent.ACTION_MOVE');expect(body).toContain('MotionEvent.ACTION_CANCEL');expect(body).toContain('observer?.restore(activity.window)');
  expect(body).toContain('Dead-zone output must stop');expect(body).toContain('Final UP must not repeat or click the original arrow');
});

test('native IME failed-editor observation exposes each unchanged predicate clause without reading private editor data',async()=>{
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('fun terminalEditor() {')[1].split('val toolbarOrder =')[0];
  const selectorInterpolation='${JSONObject.quote("button[aria-label=\'Disconnect ${fixture.getString("name")}\']")}';
  const expressions=[...body.matchAll(/"""([\s\S]*?)"""/g)].map(match=>match[1].replaceAll(selectorInterpolation,JSON.stringify("button[aria-label='Disconnect owned']")).replaceAll('$collectOrder','false').replaceAll('${JSONObject.quote(nonce)}',JSON.stringify('owned')));
  expect(expressions).toHaveLength(2);
  const predicate=new Function('document',`return (${expressions[0]});`),observe=new Function('document','getComputedStyle',`return (${expressions[1]}).editor;`);
  let count=1,focus=true,hidden=false,active=true,session=true,panePresent=true,review=false,ended=false,modal=false,visibility:unknown='visible',rects:unknown=[{}];
  const pane={getClientRects:()=>rects,querySelector:(selector:string)=>{expect(['.terminal-edit-review',':scope > .session-notice[role=status]']).toContain(selector);return (selector==='.terminal-edit-review'?review:ended)?{}:null;}};
  const computedStyle=(target:unknown)=>{expect(target).toBe(pane);return {display:'flex',visibility};};
  const area={readOnly:false,disabled:false,type:'textarea',autocomplete:'off',spellcheck:false,
    getAttribute:(name:string)=>{expect(name).toBe('autocorrect');return autocorrect;},
    closest:(selector:string)=>{expect(selector).toBe('.terminal-pane');return panePresent?pane:null;}};
  let autocorrect='off',privateReads=0;
  for(const target of [area,pane])for(const key of ['value','textContent','selectionStart','selectionEnd','id'])Object.defineProperty(target,key,{get(){privateReads++;throw new Error('private field');}});
  const document={hasFocus:()=>focus,get hidden(){return hidden;},get activeElement(){return active?area:null;},
    querySelectorAll:(selector:string)=>{expect(selector).toBe('.terminal-canvas .xterm-helper-textarea');return Array.from({length:count},()=>area);},
    querySelector:(selector:string)=>{if(selector==='[role=dialog][aria-modal=true]')return modal?{}:null;expect(selector).toBe("button[aria-label='Disconnect owned']");return session?{getClientRects(){throw new Error('Visibility must not alter DOM session presence');}}:null;}};
  Object.defineProperty(document,'URL',{get(){privateReads++;throw new Error('private URL');}});
  const expected={count:'one',focus:true,visible:true,active:true,writable:true,enabled:true,normalType:true,autocompleteOff:true,autocorrectOff:true,spellcheckOff:true,sessionPresent:true,unappliedReviewPresent:false,endedNoticePresent:false,modalPresent:false,paneDisplayed:true};
  expect(predicate(document)).toBe(true);expect(observe(document,computedStyle)).toEqual(expected);expect(predicate(document)).toBe(true);
  const cases=[
    ['focus',()=>{focus=false;},()=>{focus=true;}],['visible',()=>{hidden=true;},()=>{hidden=false;}],
    ['active',()=>{active=false;},()=>{active=true;}],['writable',()=>{area.readOnly=true;},()=>{area.readOnly=false;}],
    ['enabled',()=>{area.disabled=true;},()=>{area.disabled=false;}],['normalType',()=>{area.type='password';},()=>{area.type='textarea';}],
    ['autocompleteOff',()=>{area.autocomplete='on';},()=>{area.autocomplete='off';}],['autocorrectOff',()=>{autocorrect='on';},()=>{autocorrect='off';}],
    ['spellcheckOff',()=>{area.spellcheck=true;},()=>{area.spellcheck=false;}],['sessionPresent',()=>{session=false;},()=>{session=true;}],
  ] as const;
  for(const [field,breakClause,restore]of cases) {
    breakClause();expect(predicate(document)).toBe(false);expect(observe(document,computedStyle)).toEqual({...expected,[field]:false});expect(predicate(document)).toBe(false);restore();
  }
  for(const amount of [0,2]) {
    count=amount;expect(predicate(document)).toBe(false);
    const result=observe(document,computedStyle);expect(result.count).toBe(amount===0?'zero':'many');
    for(const field of ['active','writable','enabled','normalType','autocompleteOff','autocorrectOff','spellcheckOff','unappliedReviewPresent','endedNoticePresent','modalPresent','paneDisplayed'])expect(result[field]).toBeNull();
  }
  count=1;
  for(const [field,change,restore] of [
    ['unappliedReviewPresent',()=>{review=true;},()=>{review=false;}],['endedNoticePresent',()=>{ended=true;},()=>{ended=false;}],
    ['modalPresent',()=>{modal=true;},()=>{modal=false;}],['paneDisplayed',()=>{rects=[];},()=>{rects=[{}];}],
  ] as const) {
    change();expect(observe(document,computedStyle)).toEqual({...expected,[field]:field!=='paneDisplayed'});expect(predicate(document)).toBe(true);restore();
  }
  panePresent=false;const missing=observe(document,computedStyle);
  for(const field of ['unappliedReviewPresent','endedNoticePresent','modalPresent','paneDisplayed'])expect(missing[field]).toBeNull();
  expect(predicate(document)).toBe(true);panePresent=true;
  for(const value of ['hidden','collapse']){visibility=value;expect(observe(document,computedStyle).paneDisplayed).toBe(false);}visibility='visible';
  for(const unavailable of [undefined,{length:-1},{length:1.5}]){rects=unavailable;expect(observe(document,computedStyle).paneDisplayed).toBeNull();}rects=[{}];
  for(const unavailable of [undefined,'private-visibility']){visibility=unavailable;expect(observe(document,computedStyle).paneDisplayed).toBeNull();}visibility='visible';
  const geometry={};for(const key of ['x','y','width','height','left','top'])Object.defineProperty(geometry,key,{get(){privateReads++;throw new Error('Private rectangle read');}});
  rects=[geometry];expect(observe(document,computedStyle).paneDisplayed).toBe(true);
  expect(privateReads).toBe(0);expect(predicate(document)).toBe(true);
  expect(observe({...document,querySelectorAll:()=>{throw new Error('unavailable');}},computedStyle)).toBeNull();
  expect(JSON.stringify(observe(document,computedStyle))).not.toMatch(/private|URL|selection|owned|password|textarea|off/);
  const preferences=kotlin.split('private fun openOwnedInputPreferences(')[1].split('private fun verifyPastBottomKeyboardDismiss(')[0];
  expect(preferences).toContain('workspaceElementVisible("button[aria-label=\'Preferences\']")');
  expect(preferences).toContain('else workspaceMenuAction(scenario,"Preferences")');
});

test('native D-pad count and neutral observations execute the embedded source with closed current-pad ownership',async()=>{
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('private fun verifySshDpadPan(')[1].split('private inner class OwnedRawSshInput(')[0],nonce='0123456789abcdef'.repeat(2);
  const source=body.match(/val countExpression = """([\s\S]*?)"""\.trimIndent\(\)/)![1].replaceAll('${nonce}',nonce);
  const neutral=body.match(/while\(heldRead\("([^"\n]+)"\)!="true"\)/)![1];
  let padCount=1,buttonCount=4,outline='',text=`PRIVATE_CONTEXT D_${nonce}_3_2_2_2`;
  const buttons=()=>Array.from({length:buttonCount},()=>({style:{outline}}));
  const pad={querySelectorAll:buttons,isConnected:true},surface={get textContent(){return text;},isConnected:true};
  let currentPad=pad,currentSurface=surface;
  const document={querySelectorAll:(selector:string)=>selector==='.terminal-dpad'?Array.from({length:padCount},()=>currentPad):buttons(),querySelector:()=>currentSurface};
  const counts=new Function('document',`return (${source});`),quiet=new Function('document',`return (${neutral});`);
  const first=counts(document);
  expect(first).toEqual([3,2,2,2]);expect(quiet(document)).toBe(true);
  text+=` D_${nonce}_3_2_2_3`;expect(counts(document)).toEqual([3,2,2,3]);
  expect(first).toEqual([3,2,2,2]);
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE_CONTEXT|D_|0123456789abcdef/);
  for(const index of [0,1,2,3]) {
    const invalid=[3,2,2,2];invalid[index]=33;text=`PRIVATE_CONTEXT D_${nonce}_${invalid.join('_')}`;
    expect(counts(document)).toBeNull();
  }
  text=`PRIVATE_CONTEXT D_${nonce}_3_2_2_3`;
  outline='1px solid';expect(quiet(document)).toBe(false);outline='';
  for(const invalidPads of [0,2]){padCount=invalidPads;expect(counts(document)).toBeNull();}
  padCount=1;buttonCount=0;expect(counts(document)).toBeNull();expect(quiet(document)).toBe(false);
  buttonCount=3;expect(counts(document)).toBeNull();buttonCount=4;text=`PRIVATE_CONTEXT D_${nonce}_99_2_2_2`;expect(counts(document)).toBeNull();
  text='PRIVATE_CONTEXT_WITHOUT_A_RECEIVER_STATE';expect(counts(document)).toBeNull();
  const owner='owned-read',key=`__lazyshDpadRead_${nonce}`,window:Record<string,any>={};
  const expression=(name:string)=>body.match(new RegExp(`val ${name} = \"\"\"([\\s\\S]*?)\"\"\"\\.trimIndent\\(\\)`))![1]
    .replaceAll('${nonce}',nonce).replaceAll('${readOwner}',owner);
  const bind=new Function('window','document',`return (${expression('bindingExpression')});`);
  const valid=new Function('window','document',`return (${expression('guardExpression')});`);
  expect(bind(window,document)).toBe(true);expect(valid(window,document)).toBe(true);
  expect(bind(window,document)).toBe(false);
  expect(valid(window,{...document})).toBe(false);
  currentPad={...pad};expect(valid(window,document)).toBe(false);currentPad=pad;
  currentSurface={...surface};expect(valid(window,document)).toBe(false);currentSurface=surface;
  pad.isConnected=false;expect(valid(window,document)).toBe(false);pad.isConnected=true;
  surface.isConnected=false;expect(valid(window,document)).toBe(false);surface.isConnected=true;
  padCount=2;expect(valid(window,document)).toBe(false);padCount=1;
  window[key].owner='other';expect(valid(window,document)).toBe(false);
});

test('past-bottom native checkpoint executes closed checkbox and visible upward-stroke geometry source',async()=>{
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('private fun verifyPastBottomKeyboardDismiss(')[1].split('private fun verifySshDpadPan(')[0];
  const geometry=body.match(/val geometryExpression = """([\s\S]*?)"""\.trimIndent\(\)/)![1];
  const checkbox=body.match(/val checkboxState = """([\s\S]*?)"""\.trimIndent\(\)/)![1];
  let rect={left:10,top:20,right:310,bottom:220},present=true;
  const window={innerWidth:320,innerHeight:240,visualViewport:{offsetLeft:0,offsetTop:0,width:320,height:240,scale:1}};
  const document={querySelector:()=>present?{getBoundingClientRect:()=>rect}:null};
  const read=new Function('document','window',`return (${geometry});`);
  expect(read(document,window)).toEqual([160,208,152,320]);
  const point=read(document,window);expect(point[2]-point[1]).toBe(-56);expect(point[1]-point[2]).toBeGreaterThanOrEqual(48);
  window.visualViewport.height=120;expect(read(document,window)).toEqual([160,108,52,320]);
  rect={...rect,bottom:90};expect(read(document,window)).toBeNull();rect={...rect,bottom:220};
  window.visualViewport.scale=2;expect(read(document,window)).toBeNull();window.visualViewport.scale=1;
  rect={...rect,left:NaN};expect(read(document,window)).toBeNull();rect={...rect,left:10};present=false;expect(read(document,window)).toBeNull();
  const option='Hide keyboard when scrolling past local history bottom';let checked:unknown=false,count=1;
  const inputs=()=>Array.from({length:count},()=>({checked,value:'PRIVATE_INPUT_MUST_NOT_ESCAPE'}));
  const labels={querySelectorAll:()=>[{textContent:'PRIVATE_OTHER_LABEL',querySelectorAll:inputs},{textContent:option,querySelectorAll:inputs}]};
  const state=new Function('document',`return (${checkbox});`);
  expect(state(labels)).toBe(false);checked=true;expect(state(labels)).toBe(true);
  checked='PRIVATE_INVALID_CHECKED';expect(state(labels)).toBeNull();checked=false;
  for(const size of [0,2]){count=size;expect(state(labels)).toBeNull();}
});

test('past-bottom passive actual-owner receipt waits for trusted same-contact DOM moves and end without exporting context',async()=>{
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('private fun verifyPastBottomKeyboardDismiss(')[1].split('private fun verifySshDpadPan(')[0];
  const source=body.match(/val receiptSource = """([\s\S]*?)"""\.trimIndent\(\)/)![1];
  const create=()=>{
    const hooks=new Map<string,(event:unknown)=>void>(),area={readOnly:false};
    const document={activeElement:area as unknown,querySelector:(_selector:string)=>owner};
    const owner={ownerDocument:document,isConnected:true,querySelector:()=>area,
      addEventListener:(kind:string,handler:(event:unknown)=>void,options:unknown)=>{expect(options).toEqual({capture:true,passive:true});hooks.set(kind,handler);},
      removeEventListener:(kind:string,handler:unknown,capture:unknown)=>{expect(capture).toBe(true);expect(hooks.get(kind)).toBe(handler);hooks.delete(kind);}};
    const receipt=new Function('owner','document',`${source};return ownedPastBottomTouchReceipt(owner);`)(owner,document);
    const fire=(kind:string,y:number,extra:Record<string,unknown>={})=>{
      const touch={identifier:7,clientY:y};
      hooks.get(kind)!({isTrusted:true,currentTarget:owner,composedPath:()=>[owner],touches:kind==='touchend'?[]:[touch],changedTouches:[touch],
        privatePrompt:'PRIVATE_CONTEXT',preventDefault(){throw Error('Must remain passive');},stopPropagation(){throw Error('Must remain passive');},...extra});
    };
    return {receipt,fire,hooks,owner,document};
  };
  const good=create();expect(good.receipt.read().moves).toBe(0);
  good.fire('touchstart',100);expect(good.receipt.read()).toMatchObject({starts:1,moves:0,ends:0,trusted:true,sameContact:true});
  good.fire('touchmove',72);expect(good.receipt.read()).toMatchObject({moves:1,ends:0,distance48:false});
  good.fire('touchmove',44);expect(good.receipt.read()).toMatchObject({moves:2,ends:0,distance48:true,monotonicUp:true});
  good.document.activeElement=null;good.fire('touchend',44);
  expect(good.receipt.read()).toEqual({available:true,retained:true,starts:1,moves:2,ends:1,cancels:0,overflow:false,trusted:true,sameContact:true,insideOwner:true,monotonicUp:true,distance48:true,focused:false});
  good.receipt.dispose();expect(good.hooks.size).toBe(0);
  for(const [extra,field] of [[{isTrusted:false},'trusted'],[{currentTarget:null},'insideOwner'],[{composedPath:()=>[]},'insideOwner']] as const){
    const sample=create();sample.fire('touchstart',100,extra);expect(sample.receipt.read()[field]).toBe(false);sample.receipt.dispose();
  }
  const wrong=create();wrong.fire('touchstart',100);wrong.fire('touchmove',110);expect(wrong.receipt.read().monotonicUp).toBe(false);
  wrong.fire('touchmove',40,{touches:[{identifier:8,clientY:40}]});expect(wrong.receipt.read().sameContact).toBe(false);
  wrong.owner.isConnected=false;expect(wrong.receipt.read().retained).toBe(false);wrong.receipt.dispose();
});

test.each([
  {privateTtyGroup:false},
  {privateTtyGroup:true,companion:true},
  {privateTtyGroup:true,moshBinary:'/owned-not-executed'},
  {privateTtyGroup:true,sharedNavigation:true},
])('owned receiver root denies incompatible fixture scope before any process $privateTtyGroup $companion $moshBinary $sharedNavigation',async options=>{
  const spawn=spyOn(childProcess,'spawn').mockImplementation(()=>{throw new Error('No fixture process admitted');});
  try {
    await expect(SshFixture.start(undefined,{...options,ownedReceiverRoot:true})).rejects.toThrow('Owned receiver root requires its isolated private TTY fixture');
    expect(spawn).not.toHaveBeenCalled();
  } finally {spawn.mockRestore();}
});

test('owned receiver root refuses tool identity before any process',async()=>{
  const spawn=spyOn(childProcess,'spawn').mockImplementation(()=>{throw new Error('No fixture process admitted');});
  try {
    await expect(SshFixture.start({} as never,{privateTtyGroup:true,ownedReceiverRoot:true})).rejects.toThrow('Owned receiver root requires its isolated private TTY fixture');
    expect(spawn).not.toHaveBeenCalled();
  } finally {spawn.mockRestore();}
});

test('owned receiver root reuses protected mounts only for raw Android input fixtures',async()=>{
  const fixture=await readFile(new URL('./support/sshFixture.ts',import.meta.url),'utf8');
  const support=await readFile(new URL('./support/androidSsh.ts',import.meta.url),'utf8');
  expect(fixture).toContain('const ownedRoot=!!tools || options.ownedReceiverRoot===true');
  expect(fixture).toContain('if(ownedRoot) {');
  expect(fixture).toContain("if(tools)toolNamespace=[...namespace,'--proc','/proc']");
  expect(fixture).toContain(":ownedRoot?['--proc','/proc']:[]");
  expect(support.match(/ownedReceiverRoot:true/g)?.length).toBe(1);
  expect(support).toContain('rawInput?{privateTtyGroup:true,ownedReceiverRoot:true}');
});

test('owned receiver metadata uses its actual bounded CRLF and LF parser',async()=>{
  const source=await readFile(new URL('./android-ssh-host.test.ts',import.meta.url),'utf8');
  const expression=source.match(/const metadata=\(\)=>client!\.stdout\.match\((new RegExp\(marker\+'[^']+'\))\);/)?.[1];
  expect(expression!==undefined).toBe(true);
  const marker='ROOT_'+'0'.repeat(32)+':';
  const parser=Function('marker',`return ${expression}`)(marker) as RegExp;
  for(const ending of ['\r\n','\n'])expect((marker+'1000:65534:0:1000'+ending).match(parser)?.slice(1)).toEqual(['1000','65534','0','1000']);
  for(const value of [marker+'1000:65534:0:1000',marker+'1000:65534::1000\n',marker+'1000:65534:0:no\n',marker+'1000:65534:0:12345678901\n',"printf 'ROOT_%s:%s:%s:%s:%s\\n' '"+'0'.repeat(32)+"'\r\n"])
    expect(parser.test(value)).toBe(false);
  expect(source).toContain("'owned namespaced SSH raw receiver root rejects the old namespace and admits exact delivery'");
  expect(source).toContain('(image.mode&0o100)!==0 && (image.mode&0o022)===0');
  expect(source).toContain("writeFile(binary,bytes,{mode:0o500,flag:'wx'})");
});


test('owned receiver source admits Cargo hardlinks but execution copies stay private',async()=>{
  const source=await readFile(new URL('./android-ssh-host.test.ts',import.meta.url),'utf8');
  const sourceExpression=source.match(/const sourceAdmitted=([^;]+);/)?.[1];
  const copyExpression=source.match(/const copyAdmitted=([^;]+);/)?.[1];
  expect(sourceExpression!==undefined && copyExpression!==undefined).toBe(true);
  const admitsSource=Function('image','bytes',`return ${sourceExpression}`) as (image:Awaited<ReturnType<typeof lstat>>,bytes:Buffer)=>boolean;
  const admitsCopy=Function('copy',`return ${copyExpression}`) as (copy:Awaited<ReturnType<typeof lstat>>)=>boolean;
  const directory=await mkdtemp(join(tmpdir(),'lazysh-receiver-admission-'));
  const cargo=join(directory,'cargo'),alias=join(directory,'cargo-alias'),copy=join(directory,'copy');
  const bytes=Buffer.from('owned-nonexecuted-fixture');
  try {
    await writeFile(cargo,bytes,{mode:0o755,flag:'wx'});await link(cargo,alias);
    const image=await lstat(cargo);expect(image.nlink).toBe(2);
    expect(admitsSource(image,bytes)).toBe(true);expect(admitsCopy(image)).toBe(false);
    await writeFile(copy,bytes,{mode:0o500,flag:'wx'});
    expect(admitsCopy(await lstat(copy))).toBe(true);
    expect((await readFile(copy)).equals(bytes)).toBe(true);
    await chmod(cargo,0o775);expect(admitsSource(await lstat(cargo),bytes)).toBe(false);
    await chmod(cargo,0o655);expect(admitsSource(await lstat(cargo),bytes)).toBe(false);
    await symlink(copy,join(directory,'symlink'));
    expect(admitsSource(await lstat(join(directory,'symlink')),bytes)).toBe(false);
    expect(admitsCopy(await lstat(join(directory,'symlink')))).toBe(false);
    expect(admitsSource(image,Buffer.alloc(1024*1024))).toBe(false);
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('owned receiver probe diagnostic exports closed classifiers without captured values',async()=>{
  const source=await readFile(new URL('./android-ssh-host.test.ts',import.meta.url),'utf8');
  const classify=receiverProbeErrors;
  const categories=['auth','key','hostkey','pty','channel','shell','fs','proc','accountLocked','accountMissing','uidSwitch','authorizedKeyRead','ownership','sandbox','accountDenied','unknown'];
  for(const [text,expected] of [['Permission denied (publickey)','auth'],['Load key private-fixture: invalid format','key'],['Host key verification failed','hostkey'],['PTY allocation request failed','pty'],['channel 0: open failed','channel'],['shell request failed','shell'],['No such file or directory','fs'],['cannot mount /proc/owned','proc'],['User private-fixture not allowed because account is locked','accountLocked'],['Invalid user private-fixture','accountMissing'],['setresuid private-fixture: Operation not permitted','uidSwitch'],["Could not open user 'private-fixture' authorized keys 'private-path': Permission denied",'authorizedKeyRead'],['Authentication refused: bad ownership or modes for private-path','ownership'],['safe_path private-path: fatal','ownership'],['sandbox private-path failed','sandbox'],['seccomp violation private-fixture','sandbox'],['PAM account management error for private-fixture','accountDenied'],['User private-fixture not allowed because shell private-path does not exist','accountDenied'],['private-fixture-secret','unknown']]) {
    const result=classify(text);
    expect(Object.keys(result)).toEqual(categories);
    expect(Object.values(result).every(value=>typeof value==='boolean')).toBe(true);
    expect(result[expected]).toBe(true);
    expect(JSON.stringify(result).includes('private-fixture')).toBe(false);
  }
  expect(Object.values(classify('')).some(Boolean)).toBe(false);
  expect(classify('Permission denied (publickey)').fs).toBe(false);
  expect(classify('open private-path: Permission denied').fs).toBe(true);
  for(const text of ['ordinary account private-fixture','sandbox ordinary','seccomp ordinary','safe_path ordinary','getpwnam ordinary']) {
    const result=classify(text);
    expect(result.unknown).toBe(true);
    expect(Object.entries(result).filter(([key])=>key!=='unknown').some(([,value])=>value)).toBe(false);
  }
  expect(source).toContain("stage:'prompt'|'metadata'|'rejection'|'ready'|'delivery'");
  expect(source).toContain("lane:ownedReceiverRoot?'owned':'legacy'");
  expect(source).toContain("catch{return {state:'observation-unavailable',exitCode:null};}");
});

test('native D-pad remeasures the actual visible target after its keyboard-opening tap',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=source.split('private fun verifySshDpadPan(')[1].split('private inner class OwnedRawSshInput(')[0];
  const expression=body.match(/val heldBoundsExpression = """([\s\S]+?)"""/)?.[1];
  expect(expression!==undefined).toBe(true);
  const observe=Function('document','innerWidth','innerHeight',`return (${expression});`);
  let rect={left:80,top:600,right:120,bottom:640,width:40,height:40},height=800,hit=true,count=1;
  const button={getBoundingClientRect:()=>rect,contains:(value:unknown)=>value===button,getClientRects:()=>[rect]};
  const document={querySelectorAll:(selector:string)=>{expect(selector).toBe('.terminal-dpad button[aria-label="D-pad up"]');return count===1?[button]:[];},elementFromPoint:()=>hit?button:null};
  const before=observe(document,400,height);expect(before).toEqual([80,600,120,640,400,800]);
  height=480;expect(observe(document,400,height)).toBeNull();
  rect={left:80,top:300,right:120,bottom:340,width:40,height:40};
  expect(observe(document,400,height)).toEqual([80,300,120,340,400,480]);
  expect(observe(document,400,height)).not.toEqual(before);
  hit=false;expect(observe(document,400,height)).toBeNull();hit=true;
  count=2;expect(observe(document,400,height)).toBeNull();count=1;
  rect={...rect,left:-1};expect(observe(document,400,height)).toBeNull();
  expect(body.indexOf('val heldBounds =')).toBeGreaterThan(body.indexOf('one native D-pad tap delivered once'));
  expect(body).toContain('getLocalVisibleRect(visible)');expect(body).toContain('visible.offset(origin[0],origin[1])');
  expect(body).toContain('getWindowVisibleDisplayFrame');
  expect(body).toContain('WindowInsetsCompat.Type.ime()');
  expect(body).toContain('Owned D-pad target must stay above the current keyboard');
});

async function ownedDpadDomFixture(failure?:'listener'|'context'|'observe'|'timer'|'cleanup') {
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/OwnedDpadDomObservation.kt'),'utf8');
  const key='owned-observation-key',owner='owned-observation-token',window:Record<string,unknown>={};
  type Listener=(event:Record<string,unknown>)=>void;
  const listeners=new Map<string,Set<Listener>>(),windowListeners=new Map<string,Set<Listener>>(),viewportListeners=new Map<string,Set<Listener>>(),removed:string[]=[];
  const timers=new Map<number,()=>void>();let timerId=0;
  let clock=100,captured=true,disconnected=false,padCount=1,mutated=()=>{},focused:unknown=true,touchAction:unknown='none';
  class FixtureNode {inside=false;}
  const arrows=['up','left','down','right'].map(direction=>Object.assign(new FixtureNode(),{inside:true,dataset:{dpadDirection:direction},style:{outline:''},closest:()=>({inside:true})}));
  const pad=Object.assign(new FixtureNode(),{isConnected:true,contains:(target:unknown)=>{expect(target instanceof FixtureNode).toBe(true);return target===pad||(target as FixtureNode).inside;},
    querySelectorAll:()=>arrows,hasPointerCapture:()=>captured,
    setPointerCapture:()=>{throw new Error('Passive observation cannot capture');},releasePointerCapture:()=>{throw new Error('Passive observation cannot release');}});
  const outside=Object.assign(new FixtureNode(),{closest:()=>null});
  const terminal=Object.assign(new FixtureNode(),{matches:(selector:string)=>selector==='.terminal-canvas .xterm-helper-textarea'});
  for(const target of [...arrows,outside,terminal])for(const field of ['id','textContent','value'])Object.defineProperty(target,field,{get(){throw new Error('Private DOM field read');}});
  const eventTarget=(map:Map<string,Set<Listener>>,prefix='')=>({
    addEventListener:(type:string,listener:Listener,options:{capture:boolean;passive:boolean})=>{
      expect(options).toEqual({capture:true,passive:true});if((failure==='listener'&&type==='pointerup')||(failure==='context'&&prefix==='window:'&&type==='blur'))throw new Error('private install failure');
      if(!map.has(type))map.set(type,new Set());map.get(type)!.add(listener);
    },removeEventListener:(type:string,listener:Listener,capture:boolean)=>{expect(capture).toBe(true);removed.push(prefix+type);map.get(type)?.delete(listener);if(failure==='cleanup'&&type==='pointerdown')throw Error('private listener cleanup');}});
  const document=Object.assign(new FixtureNode(),eventTarget(listeners),{activeElement:null as unknown,visibilityState:'visible' as unknown,hasFocus:()=>focused,
    querySelectorAll:(selector:string)=>{expect(selector).toBe('.terminal-dpad');return Array.from({length:padCount},()=>pad);}});
  const viewport={width:411,height:733,offsetLeft:0,offsetTop:0,scale:1,...eventTarget(viewportListeners,'viewport:')};
  Object.assign(window,eventTarget(windowListeners,'window:'),{innerWidth:411,innerHeight:733,visualViewport:viewport});
  class Observer { constructor(callback:()=>void){mutated=callback;}observe(target:unknown,options:unknown){expect(target).toBe(pad);expect(options).toEqual({attributes:true,attributeFilter:['style'],childList:true,subtree:true});if(failure==='observe')throw new Error('private observe failure');}disconnect(){disconnected=true;} }
  const run=(name:'INSTALL'|'READ'|'CLEANUP')=>{
    const expression=source.match(new RegExp(`private val ${name} = """([\\s\\S]+?)"""\\.trimIndent\\(\\)`))?.[1];expect(expression!==undefined).toBe(true);
    const bound=expression!.replaceAll('@@KEY@@',JSON.stringify(key)).replaceAll('@@OWNER@@',JSON.stringify(owner));
    return Function('window','document','Node','MutationObserver','performance','getComputedStyle','setTimeout','setInterval','clearTimeout',`return (${bound});`)(window,document,FixtureNode,Observer,{now:()=>clock},(target:unknown)=>{expect(target).toBe(pad);return {touchAction};},(task:()=>void,delay:number)=>{expect(delay).toBe(0);if(failure==='timer')throw Error('private timer unavailable');const id=++timerId;timers.set(id,task);return id;},()=>{throw new Error('No interval');},(id:number)=>{timers.delete(id);if(failure==='cleanup')throw Error('private timer cleanup');});
  };
  const emit=(type:string,change:Record<string,unknown>={},map=listeners)=>{
    const event={type,isTrusted:true,isPrimary:true,button:0,buttons:1,pointerId:777777,pointerType:'touch',clientX:100,clientY:100,target:arrows[0],
      preventDefault:()=>{throw new Error('Passive observation cannot prevent input');},stopPropagation:()=>{throw new Error('Passive observation cannot stop input');},...change};
    for(const listener of map.get(type)??[])listener(event);return event;
  };
  return {run,emit,timers,finishTasks:()=>{for(const [id,task] of [...timers]){timers.delete(id);task();}},pad,arrows,outside,terminal,window,document,viewport,key,owner,listeners,windowListeners,viewportListeners,removed,
    mutate:()=>mutated(),setClock:(value:number)=>{clock=value;},setCapture:(value:boolean)=>{captured=value;},setPadCount:(value:number)=>{padCount=value;},
    setFocus:(value:unknown)=>{focused=value;},setTouchAction:(value:unknown)=>{touchAction=value;},disconnected:()=>disconnected};
}

test('passive owned D-pad DOM evidence observes retargeting and capture without private fields or input changes',async()=>{
  const f=await ownedDpadDomFixture();expect(f.run('INSTALL')).toBe(true);
  f.emit('pointerdown',{target:f.outside});f.emit('pointerdown',{isTrusted:false});f.emit('pointerdown',{isPrimary:false});
  expect(f.run('READ')).toMatchObject({admitted:false,events:[]});
  f.emit('pointerdown');f.emit('gotpointercapture',{target:f.arrows[0]});f.setClock(124);
  f.emit('pointermove',{target:f.outside,clientX:76});f.emit('lostpointercapture',{target:f.arrows[0]});
  const before=f.run('READ');f.emit('pointermove',{target:f.outside,pointerId:7,clientX:1});
  expect(f.run('READ')).toEqual(before);
  expect(before.events.map((row:Record<string,unknown>)=>[row.kind,row.target,row.displacement,row.capture])).toEqual([
    ['pointerdown','arrow','neutral','yes'],['gotpointercapture','arrow','neutral','yes'],['pointermove','other','left','yes'],['lostpointercapture','arrow','neutral','yes']]);
  expect(before.events[2]).toMatchObject({atMs:24,trusted:true,samePointer:true,primary:true,touch:true,pressed:true,connected:true});
  expect(Object.keys(before).sort()).toEqual(['admitted','connected','events','overflow','schemaVersion','state']);
  expect(Object.keys(before.events[0]).sort()).toEqual(['activeElement','atMs','capture','connected','displacement','documentFocus','kind','menuCancelable','menuDefaultPrevented','outline','pressed','primary','samePointer','target','touch','touchAction','trusted','viewport','visibility']);
  expect(JSON.stringify(before)).not.toMatch(/777777|clientX|clientY|pointerId|textContent|owned-observation|Private/);
  expect(f.run('CLEANUP')).toBe(true);expect([...f.listeners.values()].every(rows=>rows.size===0)).toBe(true);expect(f.disconnected()).toBe(true);
});

test('passive D-pad outline observations use only original-pad state and stop exactly on cleanup',async()=>{
  const f=await ownedDpadDomFixture();expect(f.run('INSTALL')).toBe(true);f.emit('pointerdown');
  f.arrows[0].style.outline='1px solid';f.mutate();f.mutate();
  f.arrows[0].style.outline='';f.arrows[1].style.outline='1px solid';f.mutate();
  f.arrows[0].style.outline='1px solid';f.mutate();f.arrows.forEach(arrow=>{arrow.style.outline='';});f.mutate();
  f.pad.isConnected=false;f.mutate();
  expect(f.run('READ').events.filter((row:Record<string,unknown>)=>row.kind==='outline').map((row:Record<string,unknown>)=>row.outline)).toEqual(['up','left','multiple','none','unavailable']);
  const foreign=()=>{};f.listeners.get('pointermove')!.add(foreign);
  expect(f.run('CLEANUP')).toBe(true);expect(f.listeners.get('pointermove')).toEqual(new Set([foreign]));
  expect(f.run('READ')).toEqual({state:'unavailable'});f.mutate();expect(f.run('READ')).toEqual({state:'unavailable'});
  expect(f.removed).toEqual(['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','contextmenu','focusin','focusout','visibilitychange','window:focus','window:blur','window:resize','viewport:resize','viewport:scroll']);
  expect([...f.windowListeners.values(),...f.viewportListeners.values()].every(rows=>rows.size===0)).toBe(true);
});

test('passive D-pad evidence caps rows and relative time and retires partial installation without adopting foreign state',async()=>{
  const f=await ownedDpadDomFixture();expect(f.run('INSTALL')).toBe(true);f.emit('pointerdown');f.setClock(0);f.emit('pointermove');f.setClock(999999);f.emit('pointermove');
  for(let index=0;index<40;index++)f.emit('pointermove');
  const result=f.run('READ');expect(result.events).toHaveLength(32);expect(result.overflow).toBe(true);expect(result.events[1].atMs).toBe(0);expect(result.events[2].atMs).toBe(65535);expect(f.run('CLEANUP')).toBe(true);
  for(const failure of ['listener','context','observe'] as const){const partial=await ownedDpadDomFixture(failure);expect(partial.run('INSTALL')).toBe(false);expect([...partial.listeners.values(),...partial.windowListeners.values(),...partial.viewportListeners.values()].every(rows=>rows.size===0)).toBe(true);expect(partial.run('READ')).toEqual({state:'unavailable'});}
  const foreign=await ownedDpadDomFixture();foreign.window[foreign.key]={owner:'foreign',cleanup:()=>{throw new Error('Foreign cleanup must not run');}};
  expect(foreign.run('INSTALL')).toBe(false);expect(foreign.run('CLEANUP')).toBe(false);expect(foreign.listeners.size).toBe(0);
  for(const count of [0,2]){const unavailable=await ownedDpadDomFixture();unavailable.setPadCount(count);expect(unavailable.run('INSTALL')).toBe(false);expect(unavailable.listeners.size).toBe(0);}
});


test('passive D-pad cancellation context distinguishes focus viewport and unavailable without private values',async()=>{
  const f=await ownedDpadDomFixture();expect(f.run('INSTALL')).toBe(true);
  f.emit('visibilitychange',{target:f.document});f.emit('resize',{target:f.window},f.windowListeners);
  expect(f.run('READ').events).toEqual([]);
  f.emit('pointerdown');
  expect(f.run('READ').events[0]).toMatchObject({touchAction:'none',activeElement:'none',documentFocus:'yes',visibility:'visible',viewport:'same'});
  f.document.activeElement=f.terminal;f.emit('focusin',{target:f.terminal,pointerId:undefined});
  f.setFocus(false);f.emit('blur',{target:f.window,pointerId:undefined},f.windowListeners);
  f.document.visibilityState='hidden';f.emit('visibilitychange',{target:f.document,pointerId:undefined});
  f.viewport.height=399;f.emit('resize',{target:f.viewport,pointerId:undefined},f.viewportListeners);
  const changed=f.run('READ');f.emit('resize',{target:f.window},f.windowListeners);f.emit('scroll',{target:f.viewport},f.viewportListeners);
  expect(f.run('READ')).toEqual(changed);
  expect(changed.events.map((row:Record<string,unknown>)=>[row.kind,row.activeElement,row.documentFocus,row.visibility,row.viewport])).toEqual([
    ['pointerdown','none','yes','visible','same'],['focusin','terminal','yes','visible','same'],['blur','terminal','no','visible','same'],
    ['visibilitychange','terminal','no','hidden','same'],['viewport','terminal','no','hidden','changed']]);
  f.viewport.height=733;f.emit('resize',{target:f.window,pointerId:undefined},f.windowListeners);expect(f.run('READ').events.at(-1).viewport).toBe('same');
  f.document.activeElement=f.pad;f.setTouchAction('pan-y');f.emit('focusout',{target:f.document,pointerId:undefined});
  expect(f.run('READ').events.at(-1)).toMatchObject({touchAction:'other',activeElement:'pad'});
  f.document.activeElement=f.outside;f.emit('focusin',{target:f.outside,pointerId:undefined});expect(f.run('READ').events.at(-1).activeElement).toBe('other');
  f.document.activeElement=f.window;f.setTouchAction(undefined);f.setFocus(undefined);f.document.visibilityState=undefined;f.window.visualViewport=undefined;
  f.emit('resize',{target:f.window,pointerId:undefined},f.windowListeners);
  expect(f.run('READ').events.at(-1)).toMatchObject({touchAction:'unavailable',activeElement:'unavailable',documentFocus:'unavailable',visibility:'unavailable',viewport:'unavailable'});
  f.document.activeElement=null;f.setFocus(true);f.setTouchAction('private-fixture');f.document.visibilityState='private-fixture';f.window.visualViewport=f.viewport;
  f.emit('focus',{target:f.window,pointerId:undefined},f.windowListeners);expect(f.run('READ').events.at(-1)).toMatchObject({touchAction:'other',activeElement:'none',documentFocus:'yes',visibility:'other',viewport:'same'});
  const output=JSON.stringify(f.run('READ'));expect(output).not.toMatch(/clientX|clientY|pointerId|innerWidth|height|offset|scale|777777|399|733|textContent|value|owned-observation|private-fixture/);
  expect(f.run('CLEANUP')).toBe(true);
});

test('passive D-pad contextmenu admission and transition dedup retain cap and exact document window viewport cleanup',async()=>{
  const f=await ownedDpadDomFixture();expect(f.run('INSTALL')).toBe(true);
  f.emit('contextmenu');f.emit('pointerdown',{target:f.window});f.emit('pointerdown',{target:f.document});expect(f.run('READ').admitted).toBe(false);
  f.emit('pointerdown');f.emit('contextmenu',{target:f.arrows[0],pointerId:undefined});
  expect(f.run('READ').events.at(-1)).toMatchObject({kind:'contextmenu',target:'arrow',trusted:true,samePointer:false});
  const before=f.run('READ');f.emit('contextmenu',{target:f.window,pointerId:undefined});f.emit('contextmenu',{target:f.outside,pointerId:55});expect(f.run('READ')).toEqual(before);
  f.emit('pointermove',{target:f.window});expect(f.run('READ').events.at(-1).target).toBe('other');
  for(let index=0;index<60;index++){f.setFocus(index%2===0);f.emit('blur',{target:f.window,pointerId:undefined},f.windowListeners);f.emit('focus',{target:f.window,pointerId:undefined},f.windowListeners);}
  const result=f.run('READ');expect(result.events).toHaveLength(32);expect(result.overflow).toBe(true);
  const foreign=()=>{};f.windowListeners.get('focus')!.add(foreign);expect(f.run('CLEANUP')).toBe(true);
  expect(f.windowListeners.get('focus')).toEqual(new Set([foreign]));expect([...f.listeners.values(),...f.viewportListeners.values()].every(rows=>rows.size===0)).toBe(true);
  f.emit('contextmenu');f.mutate();f.emit('resize',{target:f.viewport},f.viewportListeners);expect(f.run('READ')).toEqual({state:'unavailable'});
});


test('native SSH prompt failure preserves its original error when diagnostic reads or emission fail',async()=>{
  const source=await readFile(new URL('../apps/client/native-e2e/ssh.spec.ts',import.meta.url),'utf8');
  const body=source.split('observer=await ssh.client(true,undefined,relayPort);')[1].split('const controlOwner=')[0];
  const script=new Bun.Transpiler({loader:'ts'}).transformSync(`async function run(){${body}}`);
  const run=Function('vi','expect','reportOwnedSshPromptFailure','ssh','control','observer','relay',`${script};return run();`);
  const primary=new Error('original prompt admission failure');
  let calls=0;
  const wait={waitFor:async(_predicate:unknown,options:unknown)=>{expect(options).toEqual({timeout:3000,interval:10});throw primary;}};
  const report=async()=>{calls++;throw new Error('private diagnostic failure');};
  await expect(run(wait,expect,report,{},undefined,undefined,{active:2})).rejects.toBe(primary);
  expect(calls).toBe(1);
  calls=0;
  await expect(run(wait,expect,report,{},undefined,undefined,{get active(){throw new Error('private relay failure');}})).rejects.toBe(primary);
  expect(calls).toBe(0);
  await run({waitFor:async(predicate:()=>void)=>predicate()},expect,report,{prompt:'owned'}, {stdout:'owned'},{stdout:'owned'},{active:2});
  expect(calls).toBe(0);
});

test.skipIf(process.platform!=='linux')('SSH prompt observation separates original processes and never emits their captured text',async()=>{
  const prompt='UI_PROMPT_'+'a'.repeat(32)+'>';
  const control=new OwnedProcess(process.execPath,['-e',`process.stdout.write('private-output'.repeat(2000)+${JSON.stringify(prompt)});process.stderr.write('Permission denied private-key');setInterval(()=>{},1000)`],undefined,{PATH:'/usr/bin:/bin'});
  const observer=new OwnedProcess(process.execPath,['-e',"process.stderr.write('Host key verification failed private-host');process.exit(31)"],undefined,{PATH:'/usr/bin:/bin'});
  const events:string[]=[];const emit=spyOn(console,'error').mockImplementation(text=>{events.push(text);});
  try {
    await observer.done;
    const deadline=performance.now()+1000;
    while(!control.stdout.includes(prompt)){expect(performance.now()).toBeLessThan(deadline);await Bun.sleep(5);}
    await reportOwnedSshPromptFailure({prompt,daemon:control},control,observer,2);
    expect(events).toHaveLength(1);
    const state=JSON.parse(events[0]);
    expect(state).toMatchObject({scope:'ssh-prompt-admission',state:'sampled',activeStreams:2,activeStreamsCapped:false,
      control:{startup:{state:'running',exitCode:null},ownedLive:true,stdout:'limit',promptSeen:true,errors:{auth:true}},
      observer:{startup:{state:'early-exit',exitCode:31},ownedLive:false,stdout:'empty',promptSeen:false,errors:{hostkey:true}},daemon:{promptSeen:null}});
    expect(events[0]).not.toMatch(/private-|UI_PROMPT_|Permission denied|Host key verification/);
    expect(Object.keys(state)).toEqual(['scope','state','activeStreams','activeStreamsCapped','control','observer','daemon']);
  } finally {emit.mockRestore();await Promise.all([control.stop(),observer.stop()]);}
});

test.skipIf(process.platform!=='linux')('SSH prompt observation retains unavailable states, capped counts and failed emitters without throwing',async()=>{
  const child=new OwnedProcess('sleep',['120']);
  const descriptor=Object.getOwnPropertyDescriptor(child,'stdout')!;
  const startup=spyOn(child,'startupDiagnostic').mockRejectedValue(new Error('private startup failure'));
  const live=spyOn(child,'liveIdentity').mockRejectedValue(new Error('private identity failure'));
  Object.defineProperty(child,'stdout',{get(){throw new Error('private stream failure');},configurable:true});
  const events:string[]=[];const emit=spyOn(console,'error').mockImplementation(text=>{events.push(text);});
  try {
    const fixture={prompt:'owned-prompt',daemon:child};
    await reportOwnedSshPromptFailure(fixture,child,child,99);
    expect(JSON.parse(events[0])).toMatchObject({state:'sampled',activeStreams:8,activeStreamsCapped:true,
      control:{startup:{state:'unavailable',exitCode:null},ownedLive:null,stdout:'unavailable',promptSeen:null}});
    startup.mockResolvedValue({state:'private-state',exitCode:999} as never);
    await reportOwnedSshPromptFailure(fixture,child,child,NaN);
    expect(JSON.parse(events[1])).toMatchObject({activeStreams:null,activeStreamsCapped:null,control:{startup:{state:'unavailable',exitCode:null}}});
    await reportOwnedSshPromptFailure({get prompt(){throw new Error('private fixture failure');},daemon:child},child,child,2);
    expect(JSON.parse(events[2])).toEqual({scope:'ssh-prompt-admission',state:'unavailable'});
    expect(events.join('')).not.toContain('private');
    emit.mockImplementation(()=>{throw new Error('private emitter failure');});
    await expect(reportOwnedSshPromptFailure(fixture,child,child,2)).resolves.toBeUndefined();
  } finally {Object.defineProperty(child,'stdout',descriptor);startup.mockRestore();live.mockRestore();emit.mockRestore();await child.stop();}
});

test.skipIf(process.platform!=='linux')('SSH prompt observation distinguishes a missing original launcher from an empty live stream',async()=>{
  const child=new OwnedProcess('/nonexistent-owned-prompt-launcher',[]);const completion=child.done.catch(()=>{});
  const events:string[]=[];const emit=spyOn(console,'error').mockImplementation(text=>{events.push(text);});
  try {
    await completion;
    await reportOwnedSshPromptFailure({prompt:'owned-prompt',daemon:child},child,child,0);
    expect(JSON.parse(events[0])).toMatchObject({activeStreams:0,control:{startup:{state:'missing-launcher',exitCode:null},ownedLive:false,stdout:'empty',promptSeen:false}});
  } finally {emit.mockRestore();await child.stop().catch(()=>{});}
});


async function nativeImeOrderFixture(nonce='0123456789abcdef0123456789abcdef') {
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const source=kotlin.match(/val imeOrderInstall = """([\s\S]*?)"""\.trimIndent\(\)/)![1].replaceAll('${JSONObject.quote(nonce)}',JSON.stringify(nonce));
  const selectorInterpolation='${JSONObject.quote("button[aria-label=\'Disconnect ${fixture.getString("name")}\']")}';
  const envelope=kotlin.match(/val envelope=JSONObject\(evaluate\(scenario,"""([\s\S]*?)""",1_000\)\)/)![1]
    .replaceAll(selectorInterpolation,JSON.stringify("button[aria-label='Disconnect owned']")).replaceAll('$collectOrder','true').replaceAll('${JSONObject.quote(nonce)}',JSON.stringify(nonce));
  type Listener=(event:{target:unknown})=>void;
  const targets:ReturnType<typeof target>[]=[],timers=new Map<number,()=>void>();let nextTimer=0,scheduled=0,privateReads=0,unavailable=false,failFirstClear=false;const clearAttempts:number[]=[];
  function target() {
    const listeners=new Map<string,Set<Listener>>();
    const item={listeners,addEventListener(name:string,callback:Listener){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(callback);},
      removeEventListener(name:string,callback:Listener){listeners.get(name)?.delete(callback);},
      fire(name:string,eventTarget:unknown=item){for(const callback of listeners.get(name)??[])callback({target:eventTarget});}};
    targets.push(item);return item;
  }
  const pane={querySelector:(selector:string)=>{expect(selector).toBe('.terminal-edit-review');return null;}};
  const surface=Object.assign(target(),{closest:(selector:string)=>{expect(selector).toBe('.terminal-pane');return pane;}});
  const area=Object.assign(target(),{readOnly:false,disabled:false,isConnected:true,closest:(selector:string)=>{expect(selector).toBe('.terminal-canvas');return surface;}});
  for(const key of ['value','textContent','selectionStart','selectionEnd','id','type','autocomplete'])Object.defineProperty(area,key,{get(){privateReads++;throw new Error('private data');}});
  let current:unknown=area;
  const document=Object.assign(target(),{hidden:false,activeElement:area as unknown,hasFocus:()=>true,
    querySelectorAll:(selector:string)=>{expect(selector).toBe('.terminal-canvas .xterm-helper-textarea');if(unavailable)throw new Error('private unavailable');return current?[current]:[];}});
  type RecordRow={event:string;edge:string;owner:string;phase:string;originalPresent:boolean;connected:boolean;focused:boolean;documentFocus:boolean;visible:boolean;readOnly:boolean;enabled:boolean;reviewPresent:boolean};
  type Observer={mark(phase:string):void;stop():{state:string;initialReadOnly:boolean;overflow:boolean;events:RecordRow[]}};
  const window=Object.assign(target(),{}) as ReturnType<typeof target>&{__lazyshOwnedImeOrder?:Observer};
  const install=()=>new Function('window','document','setTimeout','clearTimeout',`return (${source});`)(window,document,(callback:()=>void)=>{scheduled++;timers.set(++nextTimer,callback);return nextTimer;},(id:number)=>{clearAttempts.push(id);if(failFirstClear&&clearAttempts.length===1)throw new Error('private timer cleanup');timers.delete(id);});
  const flush=()=>{for(const [id,callback]of [...timers]){timers.delete(id);callback();}};
  return {source,install,window,document,area,surface,timers,flush,failureEnvelope(documentInput:unknown=document){return new Function('window','document','getComputedStyle',`return (${envelope});`)(window,documentInput,()=>({visibility:'visible'}));},setCurrent(value:unknown){current=value;},setUnavailable(){unavailable=true;},
    failFirstClear(){failFirstClear=true;},clearAttempts,get scheduled(){return scheduled;},get privateReads(){return privateReads;},get listenerCount(){return targets.reduce((sum,item)=>sum+[...item.listeners.values()].reduce((n,set)=>n+set.size,0),0);}};
}

test('native IME order samples defer past dispatch and keep the original editor identity without private reads',async()=>{
  const fixture=await nativeImeOrderFixture();expect(fixture.install()).toBe(true);
  const observer=fixture.window.__lazyshOwnedImeOrder!;observer.mark('beforeSelect');observer.mark('afterSelect');observer.mark('beforeTap');
  fixture.surface.fire('pointerdown');expect(fixture.timers.size).toBe(1);
  fixture.area.readOnly=true;fixture.flush();observer.mark('afterTap');
  fixture.setCurrent({readOnly:false});fixture.area.fire('blur');fixture.flush();
  const result=observer.stop();expect(result.initialReadOnly).toBe(false);expect(result.state).toBe('observed');
  expect(result.events.find(row=>row.event==='pointerdown'&&row.edge==='capture')?.readOnly).toBe(false);
  expect(result.events.find(row=>row.event==='pointerdown'&&row.edge==='deferred')?.readOnly).toBe(true);
  expect(result.events.filter(row=>row.event==='blur').every(row=>!row.originalPresent&&row.readOnly)).toBe(true);
  expect(result.events.map(row=>row.phase)).toContain('beforeTap');expect(fixture.privateReads).toBe(0);
  expect(JSON.stringify(result)).not.toMatch(/private|textContent|selection|autocomplete/);
  expect(fixture.listenerCount).toBe(0);expect(fixture.timers.size).toBe(0);expect(fixture.window.__lazyshOwnedImeOrder).toBeUndefined();
});

test('native IME order caps records and pending macrotasks and cancels every deferred sample on cleanup',async()=>{
  const fixture=await nativeImeOrderFixture();expect(fixture.install()).toBe(true);const observer=fixture.window.__lazyshOwnedImeOrder!;
  for(let index=0;index<100;index++)fixture.surface.fire('pointerdown');
  expect(fixture.timers.size).toBeLessThanOrEqual(24);const scheduled=fixture.scheduled;
  fixture.surface.fire('click');expect(fixture.scheduled).toBe(scheduled);
  const result=observer.stop(),before=JSON.stringify(result);expect(result.events).toHaveLength(24);expect(result.overflow).toBe(true);
  fixture.flush();fixture.surface.fire('pointerup');observer.mark('afterTap');expect(JSON.stringify(result)).toBe(before);
  expect(fixture.listenerCount).toBe(0);expect(fixture.timers.size).toBe(0);
});

test('native IME order unavailable reads do not throw and never replace an existing observer or retarget an editor',async()=>{
  const fixture=await nativeImeOrderFixture();expect(fixture.install()).toBe(true);const observer=fixture.window.__lazyshOwnedImeOrder!;
  expect(fixture.install()).toBe(false);expect(fixture.window.__lazyshOwnedImeOrder).toBe(observer);
  fixture.setUnavailable();expect(()=>fixture.area.fire('focus')).not.toThrow();fixture.flush();
  const result=observer.stop();expect(result.state).toBe('unavailable');expect(result.events).toHaveLength(1);
  expect(fixture.privateReads).toBe(0);expect(fixture.listenerCount).toBe(0);expect(fixture.timers.size).toBe(0);
  const missing=await nativeImeOrderFixture();missing.setCurrent(null);expect(missing.install()).toBe(false);expect(missing.listenerCount).toBe(0);
});

test('native IME order keeps acceptance and cleanup guards and uses macrotasks rather than capture microtasks',async()=>{
  const fixture=await nativeImeOrderFixture();expect(fixture.source).toContain('setTimeout(');expect(fixture.source).not.toContain('queueMicrotask');
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('private fun verifySshImeTransactions(')[1].split('private class OwnedImeControl(')[0];
  expect(body).toContain('ime.arm(); imeOrderMark("beforeSelect"); ime.select(); imeOrderMark("afterSelect"); tapTerminal()');
  expect(body).toContain('primary=failure; finishImeOrder(failure); throw failure');expect(body).toContain('finishImeOrder(primary)');expect(body).toContain('ime.restore()');
  expect(body).toContain('failure.addSuppressed(AssertionError("IME passive order[unavailable]"))');
  expect(body).toContain('document.activeElement===area &&');expect(body).toContain('!area.readOnly && !area.disabled');expect(body).toContain('raw.original()');
  expect(fixture.source).not.toMatch(/\.readOnly\s*=/);expect(fixture.source).not.toContain('.focus(');expect(fixture.source).not.toContain('.blur(');
});


test('native IME order retains unavailable booleans and continues cleanup when one listener removal fails',async()=>{
  const fixture=await nativeImeOrderFixture();
  Object.assign(fixture.area,{readOnly:'private unexpected',disabled:'private unexpected'});
  Object.assign(fixture.document,{hidden:'private unexpected'});
  expect(fixture.install()).toBe(true);const observer=fixture.window.__lazyshOwnedImeOrder!;
  fixture.area.removeEventListener=()=>{throw new Error('private cleanup failure');};
  const result=observer.stop();expect(result.state).toBe('unavailable');expect(result.initialReadOnly).toBeNull();
  expect(result.events[0].readOnly).toBeNull();expect(result.events[0].enabled).toBeNull();expect(result.events[0].visible).toBeNull();
  expect([...fixture.surface.listeners.values()].every(set=>set.size===0)).toBe(true);
  expect([...fixture.window.listeners.values()].every(set=>set.size===0)).toBe(true);
  expect([...fixture.document.listeners.values()].every(set=>set.size===0)).toBe(true);
  const before=JSON.stringify(result);fixture.area.fire('focus');fixture.flush();expect(JSON.stringify(result)).toBe(before);
  expect(JSON.stringify(result)).not.toContain('private');expect(fixture.timers.size).toBe(0);
});


test('native IME order attempts every timer and listener cleanup after a timer cancellation failure',async()=>{
  const fixture=await nativeImeOrderFixture();expect(fixture.install()).toBe(true);const observer=fixture.window.__lazyshOwnedImeOrder!;
  fixture.surface.fire('pointerdown');fixture.surface.fire('pointerup');expect(fixture.timers.size).toBe(2);
  fixture.failFirstClear();const result=observer.stop();expect(result.state).toBe('unavailable');
  expect(fixture.clearAttempts).toHaveLength(2);expect(fixture.listenerCount).toBe(0);expect(fixture.window.__lazyshOwnedImeOrder).toBeUndefined();
  const before=JSON.stringify(result);fixture.flush();expect(JSON.stringify(result)).toBe(before);
  expect(JSON.stringify(result)).not.toContain('private');
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const mark=kotlin.split('fun imeOrderMark(phase: String)')[1].split('fun finishImeOrder')[0];
  expect(mark).toContain('.onFailure {imeOrderUnavailable=true}');expect(mark).toContain(')=="true")');
  const finish=kotlin.split('fun finishImeOrder(')[1].split('fun terminalEditor()')[0];
  expect(kotlin).toContain('if(imeOrderUnavailable)observed.put("state","unavailable")');
});


test('native IME single failure envelope stops owned observation despite editor getter failure and preserves independent results',async()=>{
  const fixture=await nativeImeOrderFixture();expect(fixture.install()).toBe(true);
  fixture.surface.fire('pointerdown');const failedEditor=fixture.failureEnvelope();
  expect(failedEditor.editor).toBeNull();expect(failedEditor.order.state).toBe('observed');
  expect(fixture.listenerCount).toBe(0);expect(fixture.timers.size).toBe(0);expect(fixture.window.__lazyshOwnedImeOrder).toBeUndefined();
  expect(JSON.stringify(failedEditor)).not.toContain('0123456789abcdef');
  const foreign=await nativeImeOrderFixture();expect(foreign.install()).toBe(true);const original=foreign.window.__lazyshOwnedImeOrder!;let calls=0;
  Object.assign(foreign.window,{__lazyshOwnedImeOrder:{owner:'foreign-private',stop(){calls++;throw new Error('private foreign');}}});
  const editor={readOnly:false,disabled:false,type:'textarea',autocomplete:'off',spellcheck:false,getAttribute:()=> 'off',closest:()=>null};
  const document={activeElement:editor,hidden:false,hasFocus:()=>true,querySelectorAll:()=>[editor],querySelector:()=>({})};
  const missingOrder=foreign.failureEnvelope(document);expect(missingOrder.editor.writable).toBe(true);expect(missingOrder.order).toBeNull();expect(calls).toBe(0);
  original.stop();expect(foreign.listenerCount).toBe(0);
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const failure=kotlin.split('fun terminalEditor()')[1].split('val toolbarOrder =')[0];
  expect(failure.match(/evaluate\(scenario/g)).toHaveLength(1);
  expect(failure.indexOf('imeOrderFinished=true')).toBeLessThan(failure.indexOf('evaluate(scenario'));
  expect(failure).toContain('if(collectOrder)retainImeOrder(order,primary)');expect(failure).toContain('throw primary');
});


test('native IME observer nonce literals encode quotes and backslashes without evaluating injected code',async()=>{
  const nonce="owned'\\literal;globalThis.privateInjected=true;//";
  const fixture=await nativeImeOrderFixture(nonce);expect(fixture.install()).toBe(true);
  const result=fixture.failureEnvelope();expect(result.order.state).toBe('observed');
  expect(JSON.stringify(result)).not.toContain(nonce);expect(Object.hasOwn(globalThis,'privateInjected')).toBe(false);
  expect(fixture.listenerCount).toBe(0);expect(fixture.window.__lazyshOwnedImeOrder).toBeUndefined();
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const observation=kotlin.split('var imeOrderInstalled = false')[1].split('val first = ime.awaitIme')[0];
  expect(observation.match(/\$\{JSONObject\.quote\(nonce\)\}/g)).toHaveLength(4);
  expect(observation).not.toContain("'${nonce}'");
});


test('D-pad final menu observation waits for dispatch, bounds tasks and never changes event defaults',async()=>{
  const f=await ownedDpadDomFixture();expect(f.run('INSTALL')).toBe(true);f.emit('pointerdown');
  const event=f.emit('contextmenu',{cancelable:true,defaultPrevented:false});
  expect(f.run('READ').events.at(-1)).toMatchObject({kind:'contextmenu',menuCancelable:'unavailable',menuDefaultPrevented:'unavailable'});
  event.defaultPrevented=true;f.finishTasks();
  expect(f.run('READ').events.at(-1)).toMatchObject({kind:'contextmenu-after',menuCancelable:'yes',menuDefaultPrevented:'yes'});
  f.emit('contextmenu',{cancelable:false,defaultPrevented:false});f.finishTasks();expect(f.run('READ').events.at(-1)).toMatchObject({menuCancelable:'no',menuDefaultPrevented:'no'});
  f.emit('contextmenu');f.finishTasks();expect(f.run('READ').events.at(-1)).toMatchObject({menuCancelable:'unavailable',menuDefaultPrevented:'unavailable'});
  f.emit('contextmenu');f.emit('contextmenu');expect(f.timers.size).toBe(1);f.finishTasks();
  f.emit('contextmenu');expect(f.timers.size).toBe(0);expect(f.run('CLEANUP')).toBe(true);
  const pending=await ownedDpadDomFixture();pending.run('INSTALL');pending.emit('pointerdown');pending.emit('contextmenu');expect(pending.timers.size).toBe(1);
  const read=pending.window[pending.key] as {read:()=>unknown};pending.run('CLEANUP');expect(pending.timers.size).toBe(0);const before=read.read();pending.finishTasks();expect(read.read()).toEqual(before);
  const foreign=await ownedDpadDomFixture();foreign.run('INSTALL');foreign.emit('pointerdown');foreign.emit('contextmenu');
  const original=foreign.window[foreign.key] as {read:()=>unknown};foreign.window[foreign.key]={owner:foreign.owner};const saved=original.read();foreign.finishTasks();expect(original.read()).toEqual(saved);
});

test('paired D-pad native observation preserves shared dispatch and original budgets while fencing queries and cleanup',async()=>{
  const base=join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client');
  const source=await readFile(join(base,'NativeWorkspaceTest.kt'),'utf8'),helper=await readFile(join(base,'OwnedDpadViewportObservation.kt'),'utf8');
  const body=source.split('private fun verifySshDpadPan(')[1].split('private inner class OwnedRawSshInput(')[0];
  expect(body).toContain('val deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(5)');
  expect(body).toContain('OwnedDpadViewportObservation(target,web,epoch)');
  expect(body.indexOf('viewportObserver?.close()')).toBeLessThan(body.indexOf('observer?.restore(activity.window)'));
  expect(body).toContain('failure.addSuppressed(AssertionError("D-pad native viewport[${viewportObserver?.failureSummary() ?: "unavailable"}]"))');
  expect(helper.match(/original\.dispatchTouchEvent\(event\)/g)).toHaveLength(1);
  expect(helper).toContain('window.callback === this');expect(helper).toContain('event.downTime == epoch');
  expect(helper).toContain('SystemClock.uptimeMillis() - epoch');expect(helper).toContain('rows.length() < 16');
  expect(helper).toContain('web.isAttachedToWindow && root.isAttachedToWindow');
  expect(helper).toContain('removeOnLayoutChangeListener(layout)');expect(helper).toContain('else { val error = IllegalStateException("Owned D-pad viewport callback changed")');
  expect(helper).not.toMatch(/requestApplyInsets|setOnApplyWindowInsetsListener|showSoftInput|hideSoftInput|requestFocus|Thread\.sleep|postDelayed|sendPointerSync/);
  expect(source).toContain('dpadViewportProjectionRejectsIncompleteOrInvalidGeometry');
});


test('D-pad final menu observation reports unavailable on read or task failure and attempts every owned teardown',async()=>{
  const broken=await ownedDpadDomFixture('timer');broken.run('INSTALL');broken.emit('pointerdown');broken.emit('contextmenu');
  expect(broken.run('READ').events.at(-1)).toMatchObject({kind:'contextmenu-after',menuCancelable:'unavailable',menuDefaultPrevented:'unavailable'});broken.run('CLEANUP');
  const query=await ownedDpadDomFixture();query.run('INSTALL');query.emit('pointerdown');
  const event=query.emit('contextmenu');Object.defineProperty(event,'cancelable',{get(){throw Error('private query denial');}});query.finishTasks();
  expect(query.run('READ').events.at(-1)).toMatchObject({menuCancelable:'unavailable',menuDefaultPrevented:'unavailable'});query.run('CLEANUP');
  const cleanup=await ownedDpadDomFixture('cleanup');cleanup.run('INSTALL');cleanup.emit('pointerdown');cleanup.emit('contextmenu');
  expect(()=>cleanup.run('CLEANUP')).toThrow('Owned D-pad observation cleanup unavailable');
  expect(cleanup.timers.size).toBe(0);expect([...cleanup.listeners.values(),...cleanup.windowListeners.values(),...cleanup.viewportListeners.values()].every(rows=>rows.size===0)).toBe(true);expect(cleanup.disconnected()).toBe(true);
  const primary=Error('original native failure');try{try{throw primary;}finally{try{cleanup.run('CLEANUP');}catch{}}}catch(error){expect(error).toBe(primary);}
});


test('paired D-pad native source wiring rejects changed epochs, missing identity fences and foreign restoration',async()=>{
  const root=join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client');
  const source=await readFile(join(root,'OwnedDpadViewportObservation.kt'),'utf8');
  const wired=(value:string)=>{
    const sample=value.slice(value.indexOf('private fun sample('),value.indexOf('override fun dispatchTouchEvent(')),dispatch=value.slice(value.indexOf('override fun dispatchTouchEvent('),value.indexOf('fun failureSummary('));
    const identity='window.callback === this && web.rootView === root && window.decorView === root && web.isAttachedToWindow && root.isAttachedToWindow';
    return sample.split(identity).length===3&&sample.includes('SystemClock.uptimeMillis() - epoch')&&sample.includes('attempts++ >= 32')&&
      dispatch.includes('event.downTime == epoch')&&dispatch.match(/original\.dispatchTouchEvent\(event\)/g)?.length===1&&
      dispatch.indexOf('sample("$action-before")')<dispatch.indexOf('original.dispatchTouchEvent(event)')&&dispatch.indexOf('original.dispatchTouchEvent(event)')<dispatch.indexOf('sample("$action-after")')&&
      value.includes('if (window.callback === this) { window.callback = original; installed = false }');
  };
  expect(wired(source)).toBe(true);
  for(const mutated of [source.replace('event.downTime == epoch','true'),source.replace('SystemClock.uptimeMillis() - epoch','0'),source.replace('window.decorView === root','true'),source.replace('attempts++ >= 32','false'),source.replace('return original.dispatchTouchEvent(event)','original.dispatchTouchEvent(event); return original.dispatchTouchEvent(event)'),source.replace('if (window.callback === this) { window.callback = original','if (true) { window.callback = original')])expect(wired(mutated)).toBe(false);
});

test('the shared Mosh history asset observes rendered overflow with closed rounding and unavailable states',async()=>{
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-mosh-history.js'),'utf8');
  expect(Buffer.byteLength(source)).toBeLessThanOrEqual(4096);
  const state={dpr:2.625,rows:12,height:'219px',row:'18.25px',scroll:'387px',visible:true,connected:true,rects:true};
  const root={get isConnected(){return state.connected;},getClientRects:()=>state.rects?[{}]:[],
    querySelector:(selector:string)=>({'.xterm-viewport':{offsetHeight:240},'.xterm-scroll-area':{style:{height:state.scroll}},'.xterm-screen':{style:{height:state.height}}})[selector],
    querySelectorAll:(selector:string)=>{expect(selector).toBe('.xterm-rows > div');return Array.from({length:state.rows},()=>({style:{height:state.row}}));}};
  Object.defineProperties(root,{textContent:{get(){throw new Error('private text read');}},id:{get(){throw new Error('private id read');}}});
  const project=(element:unknown=root)=>new Function('root','window','getComputedStyle',source+';return ownedMoshHistory(root);')(element,{devicePixelRatio:state.dpr},()=>({visibility:state.visible?'visible':'hidden'}));
  const unavailable={valid:false,rows:null,historyRows:null};
  expect(project()).toEqual({valid:true,rows:12,historyRows:8});
  Object.assign(state,{rows:6,height:'110px',row:'18.333333px',scroll:'496px'});expect(project()).toEqual({valid:true,rows:6,historyRows:14});
  state.scroll='386px';expect(project()).toEqual({valid:true,rows:6,historyRows:8});
  state.scroll='385px';expect(project()).toEqual(unavailable);
  for(const key of ['visible','connected','rects'] as const){state[key]=false;expect(project()).toEqual(unavailable);state[key]=true;}
  for(const dpr of [0,NaN,Infinity,9]){state.dpr=dpr;expect(project()).toEqual(unavailable);}
  Object.assign(state,{dpr:3,rows:1,height:'20px',row:'20px',scroll:'400px'});expect(project()).toEqual(unavailable);
  expect(project(null)).toEqual(unavailable);state.row='private-value';expect(project()).toEqual(unavailable);
  expect(JSON.stringify(project())).not.toContain('private');
});

test('Mosh-only static startup paint fills numbered rows without input or a receiver protocol',async()=>{
  const {ownedMoshResizePaint,ownedHerdrStartupPaint}=await import('./support/androidHerdr');
  const paint=await new OwnedProcess('/bin/sh',['-c',ownedMoshResizePaint()]).finish('static owned Mosh paint',1000);
  expect(paint).toBe(Array.from({length:512},(_,i)=>`OWNED_MOSH_ROW_${String(i).padStart(3,'0')}`).join('\r\n'));
  expect(ownedHerdrStartupPaint(true,false)).toBe(ownedMoshResizePaint());
  expect(ownedHerdrStartupPaint(true,true)).toBe(ownedMoshResizePaint());
  expect(ownedHerdrStartupPaint(false,true)).toBe('');
  const question=await new OwnedProcess('/bin/sh',['-c',ownedHerdrStartupPaint(false,false)]).finish('static owned question paint',1000);
  expect(question).toBe('\x1b[2J\x1b[HOWNED_QUESTION\n> OPTION_ONE\n  OPTION_TWO\n');
  const source=await readFile(join(import.meta.dir,'support/androidHerdr.ts'),'utf8');
  expect(source).toContain("navigation?'NAV_SOURCE_'+ssh.nonce:undefined,ownedHerdrStartupPaint(!!moshBinary,navigation)");
  const receiver=await readFile(join(import.meta.dir,'../apps/agent/examples/owned_terminal_receiver.rs'),'utf8');
  expect(receiver).toContain('output.write_all(part)?');expect(receiver).toContain('private_create_new().open');
  expect(source).toContain("expected.length+1");expect(source).toContain("received.equals(expected)");expect(source).toContain('receiverAlive(receiver)');
});

test('native Mosh resize observation never reads a replaced terminal owner',async()=>{
  const directory=join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest');
  const native=await readFile(join(directory,'java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const helper=native.split('private fun verifyMoshResize(')[1].split('private fun verifyGuardedHerdrChat(')[0];
  const asset=await readFile(join(directory,'assets/owned-mosh-history.js'),'utf8');
  const expression=helper.match(/val observation = """([\s\S]*?)"""/)![1].replace('$asset',asset).replaceAll('$key',JSON.stringify('owned')).replaceAll('$selector',JSON.stringify('owned-canvas'));
  const root={querySelectorAll(){throw new Error('private terminal rows read');},querySelector(){throw new Error('private terminal editor read');}};
  const pane={querySelector(){throw new Error('private replaced pane read');}},tab={};
  const document={querySelector:(selector:string)=>selector==='owned-canvas'?pane:tab};
  const window={owned:{document,pane:{},root,tab}};
  expect(new Function('window','document',`return (${expression});`)(window,document)).toEqual({valid:false,rows:null,historyRows:null,owned:false,cursorRow:null,domRows:0,composing:false,painted:false,editable:false,centerOwned:false,cursorShown:false,newestShown:false,panned:false});
});

test('native toolbar paint observation distinguishes latched Shift from released momentary keys without fixed theme colors',async()=>{
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('private fun verifySshImeTransactions(')[1].split('private class OwnedImeControl(')[0];
  const source=body.split('val toolbarState = """')[1].split('"""')[0];
  const paint={backgroundColor:'custom-surface',color:'custom-foreground',borderTopColor:'custom-border',boxShadow:'none'};
  const button={textContent:'Shift',disabled:false,getAttribute:()=> 'false' as string|null,matches:()=>false};
  const document={querySelectorAll:()=>[button]};
  const observe=new Function('document','getComputedStyle',`return (${source})`)(document,()=>paint);
  const invocation=body.match(/fun toolbarSnapshot\(name:String\)=JSONObject\(evaluate\(scenario,"([^"]+)"\)\)/)?.[1];
  expect(invocation).toBeDefined();
  const nativeSnapshot=(name:string)=>{
    const expression=invocation!.replaceAll('$toolbarState',source).replaceAll('${JSONObject.quote(name)}',JSON.stringify(name));
    const result=new Function('document','getComputedStyle',`return ${expression}`)(document,()=>paint);
    return JSON.parse(JSON.stringify(result));
  };
  expect(nativeSnapshot('Shift')).toEqual({pressed:'false',active:false,disabled:false,paint:Object.values(paint)});
  button.getAttribute=()=> 'true';expect(observe('Shift').pressed).toBe('true');
  button.textContent='enter';button.getAttribute=()=>null;button.matches=()=>true;
  expect(observe('enter')).toMatchObject({pressed:null,active:true});
  button.matches=()=>false;expect(observe('enter')).toMatchObject({pressed:null,active:false});
  document.querySelectorAll=()=>[button,button];expect(()=>observe('enter')).toThrow('unique');
  document.querySelectorAll=()=>[];expect(()=>observe('enter')).toThrow('unique');
});

test('recorded companion preflight compares full protocol values independently of JSON object key order',async()=>{
  const owner=await readFile(join(import.meta.dir,'support/recordedConversation.ts'),'utf8');
  const expression=owner.split("const page=JSON.parse(await control.finish('synthetic recorded companion preflight',5000));")[1].split('\n  }')[0];
  const {isDeepStrictEqual}=await import('node:util');
  const source={agent:'codex',sessionId:'owned-session',messages:[{role:'user',text:'Original question\nwith interior whitespace'},{role:'assistant',text:'Original complete answer'}]};
  const wire=(reverse=false)=>({schemaVersion:1,agent:source.agent,view:'active_branch',branchId:source.sessionId,messages:source.messages.map(message=>({role:message.role,blocks:[reverse?{text:message.text,type:'text'}:{type:'text',text:message.text}]}))});
  const check=(page:unknown)=>Function('page','source','isDeepStrictEqual',new Bun.Transpiler({loader:'ts'}).transformSync(expression))(page,source,isDeepStrictEqual);
  expect(()=>check(wire())).not.toThrow();expect(()=>check(wire(true))).not.toThrow();
  for(const field of ['schemaVersion','agent','view','branchId'] as const){const page=wire();Object.assign(page,{[field]:'foreign'});expect(()=>check(page)).toThrow('Synthetic recorded preflight mismatch');}
  for(const mutate of [
    (page:ReturnType<typeof wire>)=>{page.messages.reverse();},
    (page:ReturnType<typeof wire>)=>{page.messages.pop();},
    (page:ReturnType<typeof wire>)=>{page.messages[0].role='assistant';},
    (page:ReturnType<typeof wire>)=>{page.messages[0].blocks[0].text+=' changed';},
    (page:ReturnType<typeof wire>)=>{page.messages[0].blocks[0].type='reasoning';},
    (page:ReturnType<typeof wire>)=>{page.messages[0].blocks=[];},
    (page:ReturnType<typeof wire>)=>{Reflect.deleteProperty(page.messages[0].blocks[0],'text');},
    (page:ReturnType<typeof wire>)=>{page.messages[0].blocks.push({...page.messages[0].blocks[0]});},
    (page:ReturnType<typeof wire>)=>{Object.assign(page.messages[0].blocks[0],{foreign:'must not be ignored'});},
  ]){const page=wire(true);mutate(page);expect(()=>check(page)).toThrow('Synthetic recorded preflight mismatch');}
});

test('recorded Android routing preserves the ordinary owner and uses its own report and default exclusion',async()=>{
  const root=join(import.meta.dir,'..'),script=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8')).scripts;
  expect(script['test:android-ssh']).toContain('LAZYSH_ANDROID_UI_RECORDED=1');
  expect(script['test:android']).toContain('NativeWorkspaceTest#ownedRecordedConversationsThroughRealUi');
  const gradle=await readFile(join(root,'apps/client/src-tauri/gen/android/app/build.gradle.kts'),'utf8');
  expect(gradle).toContain('outputs/androidTest-results/recorded-conversation-ui');
  expect(gradle).toContain('"lazyshRecordedConversationAcceptance"');
  const specification=JSON.parse(await readFile(join(root,'apps/agent/tests/fixtures/recorded-conversations.json'),'utf8'));
  expect(specification.provenance).toContain('not an official CLI capture');
  expect(specification.messages.map((message:{role:string})=>message.role)).toEqual(['user','assistant']);
  expect(specification.opencodeSchemas.v1).toContain('CREATE TABLE session(');
  expect(specification.opencodeSchemas.v2).toContain('CREATE TABLE session_v2(');
  expect(new Set(Object.values(specification.labels)).size).toBe(3);
  expect(new Set([specification.codexThreadId,...Object.values(specification.opencodeSessions)]).size).toBe(3);
  const texts=Object.values(specification.labels).map(label=>specification.messages.map((message:{text:string})=>`${label}: ${message.text}`));
  for(let i=0;i<texts.length;i++)for(let j=0;j<i;j++)for(let message=0;message<2;message++)expect(texts[i][message]).not.toBe(texts[j][message]);
  // The shared page function both native cases evaluate, against a minimal Chat panel.
  const {recordedPageCall}=await import('./support/recordedCards');
  const {english:en}=await import('../apps/client/src/i18n/en');
  const check=(expected:string[],actual:string[],paragraphs=1,firstRole=en.chatRoleUser)=>{
    const source=recordedPageCall('messages',expected.map((text,index)=>({role:index?'assistant':'user',text})));
    const cards=actual.map((text,index)=>({querySelectorAll:()=>Array.from({length:paragraphs},()=>({})),querySelector:(selector:string)=>({textContent:selector==='h4'?(index?en.chatRoleAssistant:firstRole):text})}));
    return Function('document',`return (${source});`)({querySelector:()=>({querySelectorAll:()=>cards})});
  };
  for(let i=0;i<texts.length;i++){
    expect(check(texts[i],texts[i])).toBe(true);
    for(let j=0;j<texts.length;j++)if(i!==j)expect(check(texts[i],texts[j])).toBe(false);
    expect(check(texts[i],texts[i],2)).toBe(false);
    expect(check(texts[i],texts[i].slice(1))).toBe(false);
    expect(check(texts[i],[texts[i][0]+' changed',texts[i][1]])).toBe(false);
    expect(check(texts[i],texts[i],1,'Tool')).toBe(false);
  }

});

test('recorded select geometry reports only the bounded hit category from its existing hit test',async()=>{
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=kotlin.split('fun selectNativeOption(')[1].split('val tapScript')[0];
  const expression=body.match(/val geometry = JSONArray\(evaluate\(scenario, """([\s\S]*?)"""\)\)/)![1]
    .replace('${JSONObject.quote(selector)}',JSON.stringify('owned-select'));
  let calls=0,hit:unknown;
  const target={getBoundingClientRect:()=>({left:10,top:20,width:100,height:40}),tagName:'SELECT'};
  const document={querySelector:(selector:string)=>{expect(selector).toBe('owned-select');return target;},elementFromPoint:(x:number,y:number)=>{calls++;expect([x,y]).toEqual([60,40]);return hit;}};
  const observe=Function('document','innerWidth','innerHeight',`return (${expression});`);
  for(const [candidate,owned,category] of [[target,true,'SELECT'],[{tagName:'div'},false,'DIV'],[{tagName:'private-value'},false,'OTHER'],[null,false,'NONE']] as const){
    hit=candidate;const before=calls;
    expect(observe(document,393,852)).toEqual([60,40,393,852,100,40,owned,category]);expect(calls).toBe(before+1);
  }
  expect(body).toContain('values.all { it.isFinite() }');
  expect(body).toContain('it.toInt().coerceIn(-8192, 8192)');
  expect(body).toContain('throw failure');
});

test('recorded native report requires the exact one executed case and rejects failure, skip, stale identity and foreign cases',()=>{
  const report='<testsuites tests="1" failures="0" errors="0" skipped="0"><testcase classname="app.lazysh.client.NativeWorkspaceTest" name="ownedRecordedConversationsThroughRealUi" /></testsuites>';
  expect(validateRecordedConversationReport(report)).toEqual({nativeCase:'ownedRecordedConversationsThroughRealUi',passed:1,failed:0,skipped:0});
  for(const bad of [report.replace('tests="1"','tests="0"'),report.replace('skipped="0"','skipped="1"'),report.replace('/>','><skipped /></testcase>'),report.replace('/>','><failure /></testcase>'),report.replace('ownedRecordedConversationsThroughRealUi','ownedOpenSshConnectsThroughRealUi'),report.replace('NativeWorkspaceTest','ForeignTest'),report.replace('</testsuites>','')])
    expect(()=>validateRecordedConversationReport(bad)).toThrow('did not pass exactly once');
});

test('recorded Refresh observes completed disabled transitions and rejects old cards, stuck reads, errors and foreign ownership',async()=>{
  const {createRequire}=await import('node:module'),{JSDOM}=createRequire(import.meta.url)('jsdom');
  const native=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const body=native.split('fun verifyRecordedConversations()')[1].split('fun verifyCompanionInstallation()')[0];
  const expression=(name:string)=>body.match(new RegExp(`val ${name} = """([\\s\\S]*?)"""`))![1].replaceAll('$key',JSON.stringify('owned')).replaceAll('$token',JSON.stringify('token'));
  const cleanup=body.match(/"(\(\(\)=>\{const owned=window\[\$key\];if\(!owned\)return true;[^\n]+?)"/)![1].replaceAll('$key',JSON.stringify('owned')).replaceAll('$token',JSON.stringify('token'));
  for(const mode of ['noop','stuck','completed','batched','error','foreign']){
    const dom=new JSDOM('<div class="chat-panel"><button>Refresh new messages</button></div><div class="terminal-canvas"><div class="xterm-screen"></div></div><button role="tab"></button>');
    const window=dom.window,document=window.document,button=document.querySelector('.chat-panel button');
    const owned={token:'token',document,screen:document.querySelector('.xterm-screen'),tab:document.querySelector('[role=tab]'),refresh:undefined as any};
    window.owned=owned;
    const run=(source:string)=>Function('window','document','MutationObserver',`return (${source});`)(window,document,window.MutationObserver);
    const flush=()=>new Promise<void>(resolve=>window.queueMicrotask(resolve));
    let observer:any;
    try {
      expect(run(expression('observeRefresh'))).toBe(true);observer=owned.refresh.observer;
      expect(run(expression('refreshCompleted'))).toBe(false);
      if(mode!=='noop'){
        button.disabled=true;
        if(mode==='batched')button.disabled=false;
        await flush();
        if(mode!=='batched'){
          expect(owned.refresh.started).toBe(true);expect(run(expression('refreshCompleted'))).toBe(false);
          if(mode!=='stuck'){button.disabled=false;await flush();}
        }
      }
      if(mode==='error'){const alert=document.createElement('div');alert.setAttribute('role','alert');document.querySelector('.chat-panel').append(alert);}
      if(mode==='foreign'){
        const foreign={token:'other',get refresh(){throw new Error('private foreign observer read');}};
        window.owned=foreign;expect(run(expression('refreshCompleted'))).toBe(false);
        expect(run(cleanup)).toBe(false);expect(window.owned).toBe(foreign);
        expect(run(expression('observeRefresh'))).toBe(false);
      }else{
        expect(run(expression('refreshCompleted'))).toBe(['completed','batched'].includes(mode));
        const disconnect=spyOn(observer,'disconnect');
        expect(run(cleanup)).toBe(true);expect(disconnect).toHaveBeenCalledTimes(1);expect(Object.hasOwn(window,'owned')).toBe(false);disconnect.mockRestore();
      }
    }finally{observer?.disconnect();window.close();}
  }
});
