import {expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {identity} from '../../../../tests/support/ownedProcess';

vi.mock('node:fs/promises',()=>({readFile:vi.fn()}));

it('treats both proc disappearance errors as retired and preserves unexpected ownership-read failures',async()=>{
  for(const code of ['ENOENT','ESRCH']) {
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('process disappeared'),{code}));
    expect(await identity(123)).toBeUndefined();
  }
  const denied=Object.assign(new Error('unreadable process identity'),{code:'EACCES'});
  vi.mocked(readFile).mockRejectedValueOnce(denied);
  await expect(identity(123)).rejects.toBe(denied);
});
