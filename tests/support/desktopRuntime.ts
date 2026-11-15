// Measures a built Linux desktop binary: cold start, startup CPU, idle CPU and memory.
// Usage: bun tests/support/desktopRuntime.ts <binary> [--runs 5] [--idle 60] [--out report.json]
// shortcut: Linux /proc and X11 only (xdotool finds the first window); other platforms need their own sampler.
import {createHash} from 'node:crypto';
import {cpus, release, totalmem, tmpdir} from 'node:os';
import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {OwnedProcess} from './ownedProcess';

export const TICKS=Number(Bun.spawnSync(['getconf','CLK_TCK']).stdout.toString())||100;
// peakKiB sums each process's own peak resident size; swapKiB is the proportional share of what the kernel moved out.
export type Sample={processes:number,ticks:number,rssKiB:number,pssKiB:number,swapKiB:number,peakKiB:number};
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));

/** CPU ticks and memory of a process and every descendant, including the CPU of descendants already reaped. */
export async function sampleTree(root:number):Promise<Sample> {
  const stats=new Map<number,{parent:number,ticks:number}>();
  for(const name of await readdir('/proc')) {
    if(!/^[1-9][0-9]*$/.test(name))continue;
    const text=await readFile(`/proc/${name}/stat`,'utf8').catch(()=>'');
    // The command name may hold spaces and parentheses, so the numeric fields start after the last ')'.
    const fields=text.slice(text.lastIndexOf(')')+2).split(' ');
    if(fields.length<15)continue;
    // utime, stime, cutime, cstime: a live process's reaped children are not in any live process's own times.
    stats.set(Number(name),{parent:Number(fields[1]),ticks:fields.slice(11,15).reduce((sum,value)=>sum+Number(value),0)});
  }
  const tree=new Set<number>(stats.has(root)?[root]:[]);
  for(let grew=tree.size>0;grew;) {
    grew=false;
    for(const [pid,{parent}] of stats)if(!tree.has(pid)&&tree.has(parent)){tree.add(pid);grew=true;}
  }
  const sample:Sample={processes:tree.size,ticks:0,rssKiB:0,pssKiB:0,swapKiB:0,peakKiB:0};
  for(const pid of tree) {
    sample.ticks+=stats.get(pid)!.ticks;
    const rollup=await readFile(`/proc/${pid}/smaps_rollup`,'utf8').catch(()=>'');
    const kib=(text:string,field:string)=>Number(new RegExp(`^${field}:\\s+(\\d+) kB$`,'m').exec(text)?.[1]??0);
    sample.rssKiB+=kib(rollup,'Rss');sample.pssKiB+=kib(rollup,'Pss');sample.swapKiB+=kib(rollup,'SwapPss');
    sample.peakKiB+=kib(await readFile(`/proc/${pid}/status`,'utf8').catch(()=>''),'VmHWM');
  }
  return sample;
}

export const cpuPercent=(from:Sample,to:Sample,seconds:number)=>(to.ticks-from.ticks)/TICKS/seconds*100;
export function summarize(values:number[]) {
  const sorted=[...values].sort((a,b)=>a-b),middle=sorted.length>>1;
  if(!sorted.length)return {min:null,median:null,max:null};
  return {min:sorted[0],median:sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2,max:sorted[sorted.length-1]};
}

async function firstLine(owned:OwnedProcess,what:string) {
  for(let waited=0;waited<10_000;waited+=50) {
    if(owned.stdout.includes('\n'))return owned.stdout.split('\n')[0];
    await sleep(50);
  }
  throw new Error(`${what} did not report its address in 10 s`);
}

/** One launch of the binary on a private display, bus and profile. Everything it starts is stopped afterwards. */
export async function measureRun(binary:string,idleSeconds:number) {
  const which=(name:string)=>Bun.which(name,{PATH:process.env.PATH??''});
  const tools={Xvfb:process.env.LAZYSH_NATIVE_GUI_XVFB??which('Xvfb'),'dbus-daemon':which('dbus-daemon'),xdotool:which('xdotool')};
  const missing=Object.entries(tools).filter(([,path])=>!path).map(([name])=>name);
  if(missing.length)throw new Error(`Missing measurement tools: ${missing.join(', ')}`);
  await stat(binary);
  const directory=await mkdtemp(join(tmpdir(),'lazysh-runtime-')),started:OwnedProcess[]=[];
  try {
    for(const name of ['home','config','data','cache','runtime'])await mkdir(join(directory,name),{mode:0o700});
    const start=(program:string,args:string[],env:NodeJS.ProcessEnv)=>{const owned=new OwnedProcess(program,args,directory,env);started.push(owned);return owned;};
    const base={PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C',LC_ALL:'C'};
    const display=await firstLine(start(tools.Xvfb!,['-displayfd','1','-screen','0','1280x800x24','-nolisten','tcp'],base),'Xvfb');
    const bus=await firstLine(start(tools['dbus-daemon']!,['--session','--nofork','--print-address=1'],base),'dbus-daemon');
    const env={...base,GDK_BACKEND:'x11',DISPLAY:`:${display}`,DBUS_SESSION_BUS_ADDRESS:bus,GSETTINGS_BACKEND:'memory',
      HOME:join(directory,'home'),XDG_CONFIG_HOME:join(directory,'config'),XDG_DATA_HOME:join(directory,'data'),
      XDG_CACHE_HOME:join(directory,'cache'),XDG_RUNTIME_DIR:join(directory,'runtime')};
    const began=performance.now(),app=start(binary,[],env),pid=app.child.pid!;
    let coldStartMs:number|undefined;
    while(coldStartMs===undefined) {
      if(performance.now()-began>60_000)throw new Error('The application showed no window in 60 s');
      if(app.child.exitCode!==null)throw new Error(`The application exited with ${app.child.exitCode} before showing a window`);
      const found=Bun.spawnSync([tools.xdotool!,'search','--onlyvisible','--pid',String(pid)],{env});
      if(found.stdout.toString().trim())coldStartMs=performance.now()-began;else await sleep(20);
    }
    // Startup is over once the tree stays below 5% of one core for three seconds in a row.
    let settledMs:number|null=null,startupCpuSeconds:number|null=null,quiet=0,previous=await sampleTree(pid);
    while(settledMs===null&&performance.now()-began<90_000) {
      await sleep(1000);
      const now=await sampleTree(pid);
      quiet=now.ticks-previous.ticks<TICKS*0.05?quiet+1:0;previous=now;
      if(quiet===3){settledMs=performance.now()-began;startupCpuSeconds=now.ticks/TICKS;}
    }
    const from=await sampleTree(pid),at=performance.now();
    await sleep(idleSeconds*1000);
    const to=await sampleTree(pid);
    return {coldStartMs,settledMs,startupCpuSeconds,idleCpuPercent:cpuPercent(from,to,(performance.now()-at)/1000),
      processes:to.processes,rssMiB:to.rssKiB/1024,pssMiB:to.pssKiB/1024,swappedMiB:to.swapKiB/1024,peakRssMiB:to.peakKiB/1024};
  } finally {
    for(const owned of started.reverse())await owned.stop().catch(()=>{});
    await rm(directory,{recursive:true,force:true});
  }
}

async function environment(binary:string) {
  const webkit=Bun.spawnSync(['pkg-config','--modversion','webkit2gtk-4.1']);
  return {cpu:cpus()[0]?.model,cores:cpus().length,memoryGiB:Math.round(totalmem()/2**30),kernel:release(),
    webkit2gtk:webkit.success?webkit.stdout.toString().trim():null,binaryBytes:(await stat(binary)).size,
    binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),loadAverage:(await readFile('/proc/loadavg','utf8')).split(' ').slice(0,3).join(' ')};
}

export async function main(argv:string[]) {
  const option=(name:string,fallback:number)=>{const at=argv.indexOf(name);return at<0?fallback:Number(argv[at+1]);};
  const binary=argv[0],runs=option('--runs',5),idle=option('--idle',60),out=argv.includes('--out')?argv[argv.indexOf('--out')+1]:undefined;
  if(!binary?.startsWith('/')||!(runs>=1)||!(idle>=1))throw new Error('Usage: desktopRuntime.ts <absolute binary> [--runs 5] [--idle 60] [--out file]');
  const results=[];
  for(let run=1;run<=runs;run++){results.push(await measureRun(binary,idle));console.error(`run ${run}/${runs}`,JSON.stringify(results.at(-1)));}
  const report={environment:await environment(binary),idleSeconds:idle,runs:results,
    summary:Object.fromEntries(['coldStartMs','settledMs','startupCpuSeconds','idleCpuPercent','processes','rssMiB','pssMiB','swappedMiB','peakRssMiB']
      .map(key=>[key,summarize(results.map(result=>(result as Record<string,number|null>)[key]).filter((value):value is number=>value!==null))]))};
  const text=JSON.stringify(report,null,2);
  if(out)await writeFile(out,text+'\n');else console.log(text);
}

if(import.meta.main)main(process.argv.slice(2)).catch(error=>{console.error(String(error.message??error));process.exitCode=1;});
