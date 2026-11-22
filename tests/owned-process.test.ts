import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {descendants,identity} from './support/ownedProcess';

// The kernel answers ESRCH (not ENOENT) for the children file of a task that dies mid-read. That window is too
// narrow to hit on demand, so the read alone is simulated; /proc/<pid>/stat stays real.
const vanishing=((path:string,...rest:unknown[])=>String(path).endsWith('/children')
  ?Promise.reject(Object.assign(new Error('ESRCH: no such process'),{code:'ESRCH'}))
  :(readFile as (...args:unknown[])=>Promise<string>)(path,...rest)) as typeof readFile;

test('a process that vanishes while its children are read has no children instead of failing the walk',async()=>{
  expect(await descendants((await identity(process.pid))!,[],vanishing)).toEqual([]);
});
