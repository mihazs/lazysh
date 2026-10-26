import {expect,test,spyOn} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {OwnedProcess} from './support/androidSsh';

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
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
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
