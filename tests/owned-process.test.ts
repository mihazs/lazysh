import {expect,spyOn,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {OwnedProcess,descendants,identity} from './support/ownedProcess';

// The kernel answers ESRCH (not ENOENT) for the children file of a task that dies mid-read. That window is too
// narrow to hit on demand, so the read alone is simulated; /proc/<pid>/stat stays real.
const vanishing=((path:string,...rest:unknown[])=>String(path).endsWith('/children')
  ?Promise.reject(Object.assign(new Error('ESRCH: no such process'),{code:'ESRCH'}))
  :(readFile as (...args:unknown[])=>Promise<string>)(path,...rest)) as typeof readFile;

test('a process that vanishes while its children are read has no children instead of failing the walk',async()=>{
  expect(await descendants((await identity(process.pid))!,[],vanishing)).toEqual([]);
});

// A leader that exits while its background child keeps stdout open used to fail teardown anonymously.
test('a teardown deadline names the descendant that still holds the leader\'s stdout',async()=>{
  const owned=new OwnedProcess('sh',['-c','sleep 30 & exit 0']);
  const observed:string[]=[];
  const spy=spyOn(console,'error').mockImplementation((...values:unknown[])=>{observed.push(values.join(' '));});
  try {
    await expect(owned.stop()).rejects.toThrow('Owned fixture process teardown deadline');
  } finally {
    spy.mockRestore();
    try{process.kill(-owned.child.pid!,'SIGKILL');}catch{/* Already gone. */}
  }
  const line=observed.find(value=>value.startsWith('Owned teardown deadline observation '))!;
  expect(JSON.parse(line.slice('Owned teardown deadline observation '.length)).holders).toMatchObject([{comm:'sleep'}]);
},10_000);
