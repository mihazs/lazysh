import {expect, test} from 'bun:test';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {TmuxFixture} from '../../../../tests/support/androidTmux';
import {agentStarts, hostLaunchDirectory, hostRepository, hostWorktrees, isDirectory, parseAgentStarts, parseTmuxWindows, tmuxWindows} from './agentHost';
import type {Endpoint} from './hosts';

test('the stub agent log is read record by record, and a first argument keeps its equals signs and spaces', () => {
  const log = 'argc=1\ncwd=/h/launch/a\narg1=fix "x"; echo $HOME = ok\nargc=0\ncwd=/h/launch/b\narg1=\n';
  expect(parseAgentStarts(log)).toEqual([{argc: 1, cwd: '/h/launch/a', arg1: 'fix "x"; echo $HOME = ok'}, {argc: 0, cwd: '/h/launch/b', arg1: ''}]);
  expect(parseAgentStarts('')).toEqual([]);
  expect(() => parseAgentStarts('argc=1\ncwd=/h\n')).toThrow('partial record');
  expect(() => parseAgentStarts('cwd=/h\nargc=1\narg1=\n')).toThrow('unexpected line');
});

test('tmux windows are read from the bar-separated list and anything else is refused', () => {
  expect(parseTmuxWindows('0|%0|alpha|/h\n2|%7|agent|/h/launch/a b\n')).toEqual([{index: 0, name: 'alpha', path: '/h', paneId: '%0'}, {index: 2, name: 'agent', path: '/h/launch/a b', paneId: '%7'}]);
  expect(() => parseTmuxWindows('x|%0|alpha|/h\n')).toThrow('Unexpected tmux window row');
});

// The fixture needs the pinned tmux of the native suites, bubblewrap and the OpenSSH server, like tests/android-tmux.test.ts.
test.skipIf(process.platform !== 'linux' || !process.env.LAZYSH_TEST_TMUX)('a stub agent started in a new tmux window and a new worktree show up in the host probes', async () => {
  const owned = await TmuxFixture.start(undefined, {agentLaunch: true});
  try {
    const endpoint = {directory: owned.ssh.directory} as Endpoint;
    const folder = join(hostLaunchDirectory(endpoint), 'agent');
    const worktree = join(hostLaunchDirectory(endpoint), 'tree');
    const prompt = 'fix the "tests"; echo $HOME = done';
    expect(await agentStarts(endpoint)).toEqual([]);
    expect((await tmuxWindows(endpoint)).map(window => window.name)).toEqual(['alpha', 'beta']);
    expect(await isDirectory(folder)).toBe(false);
    expect(await hostWorktrees(endpoint)).toEqual([hostRepository(endpoint)]);
    // The same commands the app's reviewed plan runs over SSH.
    const start = await owned.ssh.client(true, `mkdir -p -- '${folder}' && git -C '${hostRepository(endpoint)}' worktree add -b tree -- '${worktree}' main && tmux -L default new-window -t '=owned-tmux:' -n agent -c '${folder}' -- codex '${prompt}'`);
    await start.finish('owned agent start', 10_000);
    for (let attempt = 0; attempt < 100 && (await agentStarts(endpoint)).length === 0; attempt++) await delay(50);
    expect(await agentStarts(endpoint)).toEqual([{argc: 1, cwd: folder, arg1: prompt}]);
    expect(await tmuxWindows(endpoint)).toContainEqual(expect.objectContaining({name: 'agent', path: folder}));
    expect(await isDirectory(folder)).toBe(true);
    expect(await hostWorktrees(endpoint)).toEqual([hostRepository(endpoint), worktree]);
  } finally {
    await owned.stop();
  }
}, 60_000);
