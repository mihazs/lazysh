import {afterEach,expect,test} from 'bun:test';
import {cpuPercent,measureRun,sampleTree,summarize,TICKS} from './support/desktopRuntime';

const children:Array<{kill:()=>void}>=[];
afterEach(()=>{for(const child of children.splice(0))child.kill();});
const spawn=(command:string[])=>{const child=Bun.spawn(command,{stdout:'ignore',stderr:'ignore'});children.push(child);return child;};
async function until<T>(read:()=>Promise<T>,done:(value:T)=>boolean) {
  for(let waited=0;waited<10_000;waited+=50){const value=await read();if(done(value))return value;await Bun.sleep(50);}
  throw new Error('Condition not reached in 10 s');
}
// A child that spends 300 ms of CPU, so the tick count has a known floor. It reads the CPU clock (a system call) once per
// million iterations: read in a hot loop, the clock reads cost more system time than the 300 ms of user time (#1897).
const burn='const end=process.cpuUsage().user+300_000;let n=0;for(;;){for(let i=0;i<1e6;i++)n+=i;if(process.cpuUsage().user>=end)break}';

test('a tree sample counts a process and its descendants, not unrelated processes',async()=>{
  const root=spawn(['sh','-c','sleep 30 & sleep 30 & wait']);
  const sample=await until(()=>sampleTree(root.pid),value=>value.processes===3);
  expect(sample.rssKiB).toBeGreaterThan(0);
  expect(sample.pssKiB).toBeGreaterThan(0);
  expect(sample.pssKiB).toBeLessThanOrEqual(sample.rssKiB);
  expect(sample.peakKiB).toBeGreaterThanOrEqual(sample.rssKiB);
  expect(sample.swapKiB).toBeGreaterThanOrEqual(0);
  expect((await sampleTree(2**22+1)).processes).toBe(0);
});

test('a tree sample includes the CPU of descendants that already exited',async()=>{
  // sh waits for the burner, then becomes sleep: the burner is gone and only the parent's reaped-child time remains.
  const root=spawn(['sh','-c','"$0" -e "$1"; exec sleep 30',process.execPath,burn]);
  const sample=await until(()=>sampleTree(root.pid),value=>value.processes===1&&value.ticks>0);
  expect(sample.ticks).toBeGreaterThanOrEqual(0.25*TICKS);
  expect(sample.ticks).toBeLessThan(2*TICKS);
});

test('idle CPU is the tick difference as a share of one core over the elapsed time',()=>{
  const sample=(ticks:number)=>({processes:1,ticks,rssKiB:0,pssKiB:0,swapKiB:0,peakKiB:0});
  expect(cpuPercent(sample(10*TICKS),sample(15*TICKS),10)).toBeCloseTo(50);
  expect(cpuPercent(sample(7),sample(7),60)).toBe(0);
});

test('summaries keep the minimum, median and maximum, and stay explicit when there is no value',()=>{
  expect(summarize([3,1,2])).toEqual({min:1,median:2,max:3});
  expect(summarize([4,1,3,2])).toEqual({min:1,median:2.5,max:4});
  expect(summarize([])).toEqual({min:null,median:null,max:null});
});

test('a run names every missing tool instead of measuring without it',async()=>{
  const saved={PATH:process.env.PATH,xvfb:process.env.LAZYSH_NATIVE_GUI_XVFB};
  process.env.PATH='/nonexistent';delete process.env.LAZYSH_NATIVE_GUI_XVFB;
  try {
    await expect(measureRun('/nonexistent/lazysh',1)).rejects.toThrow('Missing measurement tools: Xvfb, dbus-daemon, xdotool');
  } finally {
    process.env.PATH=saved.PATH;
    if(saved.xvfb!==undefined)process.env.LAZYSH_NATIVE_GUI_XVFB=saved.xvfb;
  }
});
