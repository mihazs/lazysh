import {expect,test,spyOn} from 'bun:test';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OwnedProcess,packageExitInfo,androidSshCleanup} from './support/androidSsh';

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
  const directory=await mkdtemp(join(tmpdir(),'lazysh-exit-info-'));
  const fixture=join(directory,'exit-info');
  const args=join(directory,'args');
  const adb=join(directory,'adb');
  const keys=['EXIT_INFO_FIXTURE','EXIT_INFO_ARGS','EXIT_INFO_CODE'] as const;
  const previous=keys.map(key=>process.env[key]);
  try {
    await writeFile(fixture,body);
    await writeFile(adb,`#!/bin/sh
printf '%s\\n' "$*" > "$EXIT_INFO_ARGS"
cat "$EXIT_INFO_FIXTURE"
exit "$EXIT_INFO_CODE"
`);
    await chmod(adb,0o700);
    process.env.EXIT_INFO_FIXTURE=fixture;process.env.EXIT_INFO_ARGS=args;process.env.EXIT_INFO_CODE=String(code);
    const result=await packageExitInfo(adb,'emulator-5580');
    expect(await readFile(args,'utf8')).toBe('-s emulator-5580 shell dumpsys activity exit-info app.lazysh.client\n');
    expect(result.state).toBe(state);
    expect(result.records).toEqual(state==='available'?Array.from({length:count!},()=>({timestamp:'2026-10-27 22:19:33.701',pid:3389,reason:5,subreason:0,status:6})):[]);
    const rendered=JSON.stringify(result);
    for(const secret of ['private-secret','private-state','/private/path','other.app','realUid','description','trace'])expect(rendered).not.toContain(secret);
  } finally {
    keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});
    await rm(directory,{recursive:true,force:true});
  }
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
