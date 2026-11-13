import {expect, test} from 'bun:test';
import {loadData} from './data';

test('shared data is loaded with the run nonce substituted, so the expected output matches what the command prints', async () => {
  const {echo} = await loadData<{echo: {command: string; expected: string}}>('commands', 'ab12');
  expect(echo).toEqual({command: "printf 'E2E_%s_END\\n' 'ab12'", expected: 'E2E_ab12_END'});
  const {herdrAgent} = await loadData<{herdrAgent: {workspaceLabel: string}}>('agent-records', 'ab12');
  expect(herdrAgent.workspaceLabel).toBe('HERDR_ab12');
});
