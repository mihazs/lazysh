import {expect,test,spyOn} from 'bun:test';
import {chmod,mkdir,mkdtemp,readFile,rename,rm,symlink,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import * as childProcess from 'node:child_process';
import type {HerdrFixture} from './support/androidHerdr';
import {observeAndroidMoshBackground} from './support/androidMoshBackground';
import {OwnedCaseCrashParser} from './support/androidCaseCrash';
import {SshFixture,OwnedProcess,packageExitInfo,androidSshCleanup,emulatorContinuity,compareEmulatorContinuity,hostAdbServerIdentity,compareHostAdbServer,gradleFailureClasses,captureOwnedCaseCrashes,recoverOwnedCaseCrash,ownedAndroidPackagePresence,androidSshAcceptance,ownedSoftwareKeyboard,attachmentReceipt,attachmentIdentity,validateSharedHerdrReport,sharedHerdrReportIdentity,verifySharedHerdrResult} from './support/androidSsh';

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
    await child.stop();
    expect(await child.startupDiagnostic()).toEqual({state:'signaled',exitCode:null});
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
  let capability='tmux available · Herdr detected · Zellij missing';
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
  expect(script).toBe('LAZYSH_ANDROID_UI_SSH=1 LAZYSH_ANDROID_UI_ATTACHMENTS=1 bun test ../../tests/android-ssh.test.ts ../../tests/android-ssh-host.test.ts');
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
  expect(support).toContain("(herdr || attachments)?['-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true']");
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
  const card={getClientRects:()=>[{}],getBoundingClientRect:()=>rectangle(0,0,200,110),contains:(_hit:unknown)=>false,
    querySelector:(selector:string)=>labels[['strong',':scope > small','span > small'].indexOf(selector)]};
  const state={cards:[card],blockers:[] as object[],hit:undefined as object|undefined,live:true};
  const window={visualViewport:{offsetLeft:0,offsetTop:0,width:411,height:659,scale:1}};
  const document={querySelectorAll:(selector:string)=>selector.includes('.herdr-navigation-row')?state.cards:state.blockers,
    elementFromPoint:(_x:number,y:number)=>state.hit??labels.find(label=>y>=label.bounds.top&&y<=label.bounds.bottom),
    createRange:()=>{let selected=labels[0];return {selectNodeContents:(label:typeof selected)=>{selected=label;},getClientRects:()=>selected.glyphs,getBoundingClientRect:()=>selected.bounds};}};
  return {labels,card,state,window,observe:()=>new Function('document','window',`return (${script.replace('$viewportOracle',viewport).replace('$liveHerdr',String(state.live))});`)(document,window)};
}

test('Herdr visual failure observations distinguish viewport and glyph-hit clauses without changing admission',async()=>{
  const f=await herdrVisualFixture();
  expect(f.observe()).toMatchObject({state:'observed',liveReady:true,cards:1,cardShown:true,viewportReady:true,blockers:0});
  f.state.hit=f.card;
  expect(f.observe().labels[0]).toMatchObject({present:true,glyphs:1,truncated:false,hit:'card',failedRect:[10,10,80,30]});
  f.state.live=false;f.labels[0].bounds.left=-10;
  expect(f.observe()).toMatchObject({liveReady:false,viewportReady:false});
  f.state.cards=[];expect(f.observe()).toMatchObject({cards:0,cardShown:false,cardRect:null,viewportReady:false});
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
