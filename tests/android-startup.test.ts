import {afterEach,expect,test} from 'bun:test';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capture,cpuCount,hostBudget,quota,startupObservation,cpuAllocation,waitForRetirement} from './support/androidStartup';
const temporary:string[]=[];
afterEach(async()=>{for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});

test('CPU ranges reject overlap, disorder, malformed and excessive sets',()=>{
  expect(cpuCount('0-3,8,10-11\n')).toBe(7);
  for(const text of ['', '3-1','0-3,3','1,0','0-65535','private-token','0-3,'])expect(()=>cpuCount(text)).toThrow();
});
test('quota retains fractional effective CPUs and rejects unsafe integers',()=>{
  expect(quota('max 100000')).toBeNull();expect(quota('399999 100000')).toBe(3.99999);
  for(const text of ['0 100000','4 0','private 100000','4 2 1','9007199254740993 1'])expect(()=>quota(text)).toThrow();
});
function cpuFixture(overrides:Record<string,string|Error>={}){
  const data:Record<string,string|Error>={
    '/proc/self/status':'Cpus_allowed_list:\t0-7\n', '/proc/self/cgroup':'0::/job/runner\n',
  };
  for(const level of ['/cpu/job/runner','/cpu/job','/cpu']){
    data[`${level}/cpuset.cpus.effective`]='0-7';data[`${level}/cpu.max`]='max 100000';
    data[`${level}/cpu.stat`]='usage_usec 5000\nnr_periods 9\nnr_throttled 2\nthrottled_usec 400\n';
  }
  Object.assign(data,overrides);
  return async(path:string)=>{const value=data[path];if(value instanceof Error)throw value;if(value===undefined)throw new Error('Unknown targeted input');return value;};
}
test('host admission observes ancestor quotas, cpusets, affinity and throttle counters',async()=>{
  const host=await hostBudget(cpuFixture({'/cpu/job/cpu.max':'400000 100000','/cpu/job/runner/cpuset.cpus.effective':'0-3'}),'/cpu');
  expect(host.effective).toBe(4);expect(host.levels[1].throttledUsec).toBe(400);
  expect((await hostBudget(cpuFixture({'/cpu/job/cpu.max':'399999 100000'}),'/cpu')).effective).toBeLessThan(4);
  expect((await hostBudget(cpuFixture({'/proc/self/status':'Cpus_allowed_list: 0-1'}),'/cpu')).effective).toBe(2);
  expect((await hostBudget(cpuFixture({'/cpu/cpuset.cpus.effective':'0-2'}),'/cpu')).effective).toBe(3);
});
test('unavailable quotas, traversal, missing throttle statistics and excessive hierarchy fail closed',async()=>{
  for(const changes of [
    {'/cpu/job/cpu.max':new Error('private-file-name')},
    {'/proc/self/cgroup':'0::/../../foreign'},
    {'/proc/self/cgroup':'0::/job\n1:cpu:/foreign'},
    {'/cpu/job/cpu.max':'400000 100000','/cpu/job/cpu.stat':'usage_usec 10'},
    {'/cpu/cpu.max':Object.assign(new Error('Permission denied'),{code:'EACCES'})},
  ])await expect(hostBudget(cpuFixture(changes),'/cpu')).rejects.toThrow();
});
test('root absent quota is unlimited only for ENOENT, never denied reads',async()=>{
  const host=await hostBudget(cpuFixture({'/cpu/cpu.max':Object.assign(new Error('absent'),{code:'ENOENT'})}),'/cpu');
  expect(host.effective).toBe(8);
});
test('startup observation has closed categories and incomplete input cannot become absence',()=>{
  const event='10-29 03:30:18.553 627 1483 I am_anr : [0,965,com.android.systemui,1,Process failed to complete startup]';
  expect(startupObservation(event,'----- pid 965 -----\nCmd line: com.android.systemui\nsetGpuContextPriority',true)).toEqual({anr:'startup',gpuPriority:true,bindApplication:false});
  expect(startupObservation(event.replace('failed to complete startup','another reason'),'ActivityThread.handleBindApplication',true).anr).toBe('other-systemui');
  expect(startupObservation('','',true).anr).toBe('not-observed');
  for(const [events,traces,complete] of [[event,'private-key token',false],['\0','',true],['x'.repeat(1024*1024+1),'',true]] as const){
    const result=startupObservation(events,traces,complete);expect(result.anr).toBe('unavailable');expect(JSON.stringify(result)).not.toContain('private');
  }
  expect(JSON.stringify(startupObservation('private-key token','private-path private-message',true))).not.toContain('private');
});
for(const mode of ['success','error','timeout','overflow','stderr'] as const)test(`owned foreground capture ${mode} is bounded and reaped`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-startup-capture-'));temporary.push(directory);
  const child=join(directory,'fake-adb'),pid=join(directory,'pid'),output=join(directory,'capture.txt'),argv=join(directory,'argv');
  await writeFile(child,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));fs.writeFileSync(${JSON.stringify(argv)},JSON.stringify(process.argv.slice(2)));\n${mode==='timeout'?'setInterval(()=>{},1000)':mode==='overflow'?"process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)":mode==='stderr'?"process.stderr.write('private-key warning');process.exit(0)":`process.stdout.write('synthetic startup');process.exit(${mode==='error'?23:0})`}\n`);
  await chmod(child,0o700);
  const result=await capture(child,['-s','emulator-5580','shell','dumpsys','cpuinfo'],output,mode==='timeout'?100:2000,1024);
  expect(result.status).toBe(mode==='success'?'complete':mode==='overflow'?'overflow':'unavailable');
  expect((await readFile(output)).length).toBeLessThanOrEqual(1024);
  expect(JSON.parse(await readFile(argv,'utf8'))).toEqual(['-s','emulator-5580','shell','dumpsys','cpuinfo']);
  expect(()=>process.kill(Number(require('node:fs').readFileSync(pid,'utf8')),0)).toThrow();
});

async function phaseFixture(){
  const directory=await mkdtemp(join(tmpdir(),'lazysh-startup-phase-'));temporary.push(directory);
  const {mkdir}=await import('node:fs/promises');
  const home=join(directory,'home'),base=join(directory,'lazysh-startup-cpu-budget');
  await mkdir(join(home,'.android/avd/lazysh-runtime-api36.avd'),{recursive:true});
  const sentinel=join(home,'.android/avd/lazysh-runtime-api36.avd/foreign');await writeFile(sentinel,'private foreign state');
  const env={...process.env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',RUNNER_TEMP:directory,GITHUB_WORKSPACE:directory,ANDROID_HOME:join(directory,'sdk'),HOME:home,GITHUB_ENV:join(directory,'env'),STARTUP_ACTION_OUTCOME:'failure'};
  return {directory,base,env,sentinel};
}
test.skipIf(process.platform!=='linux')('foreign AVD is rejected before any adoption or deletion',async()=>{
  const {runStartup}=await import('./support/androidStartup');const f=await phaseFixture();
  await expect(runStartup('prepare',f.env)).rejects.toThrow('inconclusive');
  expect(await readFile(f.sentinel,'utf8')).toBe('private foreign state');
  const summary=JSON.parse(await readFile(join(f.base,'results/summary.json'),'utf8'));
  expect(summary.status).toBe('inconclusive');expect(summary.samples[0].anr).toBe('unavailable');
  expect(JSON.stringify(summary)).not.toContain('private');expect(JSON.stringify(summary)).not.toContain(f.directory);
});
for(const phase of ['boot-failure','live-process','changed-avd'] as const)test.skipIf(process.platform!=='linux')(`retirement ${phase} preserves unknown state and the original failure`,async()=>{
  const {runStartup}=await import('./support/androidStartup');const {createHash}=await import('node:crypto');const {mkdir}=await import('node:fs/promises');
  const f=await phaseFixture();await mkdir(join(f.base,'results'),{recursive:true});
  const host=createHash('sha256').update((await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()).digest('hex');
  let pid:number|undefined;
  if(phase==='live-process')pid=process.pid;
  if(phase==='changed-avd'){const child=Bun.spawn([process.execPath,'-e',''],{stdout:'ignore',stderr:'ignore'});pid=child.pid;await child.exited;}
  await writeFile(join(f.base,'state.json'),JSON.stringify({index:0,host,rows:[{index:0,cores:2,reason:phase==='boot-failure'?'not-observed':'observe-unavailable',status:'inconclusive',anr:'unavailable'}],...(pid?{pid,start:'untrusted-old-identity',avd:{directory:'unknown',config:'unknown',index:'unknown'}}:{})}));
  await expect(runStartup('retire',f.env)).rejects.toThrow('inconclusive');
  expect(await readFile(f.sentinel,'utf8')).toBe('private foreign state');
  const summary=JSON.parse(await readFile(join(f.base,'results/summary.json'),'utf8'));
  expect(summary.samples[0]).toMatchObject({status:'inconclusive',anr:'unavailable',cleanup:'unavailable',reason:phase==='boot-failure'?'boot-or-action-failure':'observe-unavailable',actionOutcome:'failure'});
  expect(await readFile(f.env.GITHUB_ENV!,'utf8')).toContain('STARTUP_READY=false');
});

test('host allocation drift ignores changing usage but detects quota and affinity changes',async()=>{
  const first=await hostBudget(cpuFixture(),'/cpu');
  const later=await hostBudget(cpuFixture({'/cpu/job/cpu.stat':'usage_usec 9000\nnr_periods 90\nnr_throttled 20\nthrottled_usec 4000\n'}),'/cpu');
  expect(cpuAllocation(first)).toEqual(cpuAllocation(later));
  const changed=await hostBudget(cpuFixture({'/cpu/job/cpu.max':'400000 100000'}),'/cpu');
  expect(cpuAllocation(first)).not.toEqual(cpuAllocation(changed));
});

async function readyRetirementFixture(pid:number,start:string){
  const {createHash}=await import('node:crypto');const {mkdir,lstat}=await import('node:fs/promises');
  const f=await phaseFixture();await mkdir(join(f.base,'results'),{recursive:true});
  const avd=join(f.env.HOME!,'.android/avd/lazysh-runtime-api36.avd'),config=join(avd,'config.ini'),ini=join(f.env.HOME!,'.android/avd/lazysh-runtime-api36.ini');
  await writeFile(config,'hw.cpu.ncore=2\nhw.ramSize=3072M\nhw.device.name=pixel_2\nimage.sysdir.1=system-images/android-36/default/x86_64/\n');
  await writeFile(ini,`path=${avd}\n`);
  const proof={directory:String((await lstat(avd)).ino),config:String((await lstat(config)).ino),index:String((await lstat(ini)).ino)};
  const host=createHash('sha256').update((await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()).digest('hex');
  const rows=[2,4,4,2].map((cores,index)=>({index,cores,status:index===3?'inconclusive':'complete',reason:index===3?'awaiting-retirement':'observed-and-retired',anr:'not-observed'}));
  await writeFile(join(f.base,'state.json'),JSON.stringify({index:3,host,rows,pid,start,avd:proof}));
  const sibling=join(f.directory,'unrelated');await writeFile(sibling,'untouched');
  return {...f,config,ini,sibling};
}
for(const replaceIndex of [false,true])test.skipIf(process.platform!=='linux')(`retirement ${replaceIndex?'rejects replaced index':'removes only its proved AVD'}`,async()=>{
  const {runStartup}=await import('./support/androidStartup');const {rename}=await import('node:fs/promises');
  const child=Bun.spawn([process.execPath,'-e',''],{stdout:'ignore',stderr:'ignore'});await child.exited;
  const f=await readyRetirementFixture(child.pid,'recorded-fixture-start');
  if(replaceIndex){await rename(f.ini,`${f.ini}.saved`);await writeFile(f.ini,`path=${f.ini.slice(0,-4)}.avd\n`);}
  const operation=runStartup('retire',{...f.env,STARTUP_ACTION_OUTCOME:'success'});
  if(replaceIndex){await expect(operation).rejects.toThrow('inconclusive');expect(await readFile(f.sentinel,'utf8')).toBe('private foreign state');}
  else{await operation;expect(await Bun.file(f.config).exists()).toBe(false);}
  expect(await readFile(f.sibling,'utf8')).toBe('untouched');
  const summary=JSON.parse(await readFile(join(f.base,'results/summary.json'),'utf8'));
  expect(summary.status).toBe(replaceIndex?'inconclusive':'complete');
});

test('trace symbols belong to SystemUI only and excessive records are unavailable',()=>{
  const result=startupObservation('', '----- pid 1 -----\nCmd line: private.other\nsetGpuContextPriority',true);
  expect(result.gpuPriority).toBeNull();
  const traceOnly=startupObservation('', '----- pid 965 -----\nCmd line: com.android.systemui\nsetGpuContextPriority',true);
  expect(traceOnly.anr).toBe('not-observed');expect(traceOnly.gpuPriority).toBe(true);
  expect(startupObservation('x'.repeat(65537),'',true).anr).toBe('unavailable');
  expect(startupObservation('\n'.repeat(8192),'',true).anr).toBe('unavailable');
});
test('same-size CPU masks and equal-capacity quota periods still count as allocation drift',async()=>{
  const first=await hostBudget(cpuFixture({'/cpu/job/cpu.max':'400000 100000'}),'/cpu');
  for(const overrides of [{'/proc/self/status':'Cpus_allowed_list: 8-15'}, {'/cpu/job/cpu.max':'800000 200000'}]){
    const other=await hostBudget(cpuFixture({'/cpu/job/cpu.max':'400000 100000',...overrides}),'/cpu');
    expect(other.effective).toBe(first.effective);expect(cpuAllocation(other)).not.toEqual(cpuAllocation(first));
  }
});

test('root cgroup membership admits absent root quota and normalizes root paths',async()=>{
  const load=cpuFixture({'/proc/self/cgroup':'0::/\n','/proc/self/status':'Cpus_allowed_list: 0-3','/cpu/cpuset.cpus.effective':'0-3','/cpu/cpu.stat':'usage_usec 10\n','/cpu/cpu.max':Object.assign(new Error('absent'),{code:'ENOENT'})});
  for(const root of ['/cpu','/cpu/']){
    const host=await hostBudget(load,root);expect(host.effective).toBe(4);expect(host.levels).toHaveLength(1);expect(host.levels[0].capacity).toBeNull();
  }
});
test('root cgroup membership never treats denied root quota as unlimited',async()=>{
  const load=cpuFixture({'/proc/self/cgroup':'0::/\n','/cpu/cpu.max':Object.assign(new Error('denied'),{code:'EACCES'})});
  await expect(hostBudget(load,'/cpu/')).rejects.toThrow('denied');
});

async function recordedStart(pid:number){const stat=await readFile(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19];}
test.skipIf(process.platform!=='linux')('retirement waits for the same owned child to exit before removing its AVD',async()=>{
  const {runStartup}=await import('./support/androidStartup');
  const child=Bun.spawn([process.execPath,'-e',"process.stdin.resume();process.stdin.once('data',()=>setTimeout(()=>process.exit(0),50));"],{stdin:'pipe',stdout:'ignore',stderr:'ignore'});
  const f=await readyRetirementFixture(child.pid,await recordedStart(child.pid));
  let settled=false;
  const operation=runStartup('retire',{...f.env,STARTUP_ACTION_OUTCOME:'success'}).then(()=>{settled=true;return true;},()=>{settled=true;return false;});
  try{
    await Bun.sleep(30);expect(settled).toBe(false);expect(await Bun.file(f.config).exists()).toBe(true);
    child.stdin.end('retire');await child.exited;
    expect(await operation).toBe(true);expect(await Bun.file(f.config).exists()).toBe(false);
  }finally{try{child.stdin.end('retire');}catch{}await child.exited;await operation;}
});
test.skipIf(process.platform!=='linux')('retirement rejects changed identity and a still-live identity at its finite deadline without signals',async()=>{
  const start=await recordedStart(process.pid);
  await expect(waitForRetirement(process.pid,`${start}1`)).rejects.toThrow('identity changed');
  await expect(waitForRetirement(process.pid,start,30)).rejects.toThrow('retirement deadline');
  expect(process.kill(process.pid,0)).toBe(true);
});
