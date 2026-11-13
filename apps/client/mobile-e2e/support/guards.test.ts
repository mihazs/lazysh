import {expect, test} from 'bun:test';
import {forbidPause} from './guards';

test('a fixed-time pause fails the test that calls it', async () => {
  const replaced = new Map<string, () => Promise<never>>();
  forbidPause({overwriteCommand: (name, replacement) => { replaced.set(name, replacement); }});
  await expect(replaced.get('pause')!()).rejects.toThrow('browser.pause is not allowed');
});
