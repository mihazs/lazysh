import {expect,test,spyOn} from 'bun:test';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {OwnedProcess,packageExitInfo,androidSshCleanup,emulatorContinuity,compareEmulatorContinuity} from './support/androidSsh';

test('owned process failures never include captured output or arguments',async()=>{
  const owned=new OwnedProcess(process.execPath,['-e',"process.stderr.write('private-fixture-secret');process.exit(31)"]);
  const error=await owned.finish('synthetic failure',1000).catch(error=>error as Error);
  expect((error as Error).message).toBe('Owned fixture failed: synthetic failure; exit=31');
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
  'shell pidof') sed -n '2p' "$EXIT_INFO_FIXTURE" ;;
  'reverse --list') sed -n '3p' "$EXIT_INFO_FIXTURE" ;;
  'transport-id ') sed -n '4p' "$EXIT_INFO_FIXTURE" ;;
  'shell cat') sed -n '5p' "$EXIT_INFO_FIXTURE" ;;
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
    expect(summary).toEqual({...expected,transport:state,transportHash:null,boot:state,bootHash:null});
    expect((await readFile(args,'utf8')).trim().split('\n').sort()).toEqual([
      '-s emulator-5580 get-state','-s emulator-5580 shell pidof app.lazysh.client','-s emulator-5580 reverse --list',
      '-s emulator-5580 transport-id','-s emulator-5580 shell cat /proc/sys/kernel/random/boot_id',
    ].sort());
    expect(JSON.stringify(summary)).not.toContain('private-');
  });
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
    expect(compareEmulatorContinuity(before,after)).toEqual(expected);
    expect(compareEmulatorContinuity(undefined,after)).toEqual({transport:'unknown',boot:'unknown',reverseLost:null});
    expect((await readFile(args,'utf8')).trim().split('\n')).toHaveLength(10);
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
