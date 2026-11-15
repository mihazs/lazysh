import {execFile} from 'node:child_process';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {agentLaunchLog, agentLaunchRepository} from '../../../../tests/support/androidTmux';
import type {Endpoint} from './hosts';

// What the owned tmux host shows after the app's New agent flow ran: read from the host itself, never from the app's screen. The
// host's own folder comes with its endpoint, and the tmux client is the fixture's pinned copy on its private socket directory.

const run = promisify(execFile);
const SESSION = 'owned-tmux';

/** One start of the host's stub agent: how many arguments it got, the folder it ran in and its first argument. */
export interface AgentStart {argc: number; cwd: string; arg1: string}
export interface TmuxWindow {index: number; name: string; path: string; paneId: string}

/** Reads the `argc`, `cwd` and `arg1` lines the stub appends per start; a first argument may contain `=`, so only the first one splits. */
export function parseAgentStarts(log: string): AgentStart[] {
  const lines = log.split('\n').filter(Boolean);
  if (lines.length % 3 !== 0) throw new Error(`The stub agent log has a partial record (${lines.length} lines)`);
  const value = (line: string, key: string) => {
    if (!line.startsWith(`${key}=`)) throw new Error(`The stub agent log has an unexpected line where ${key} belongs`);
    return line.slice(key.length + 1);
  };
  const starts: AgentStart[] = [];
  for (let at = 0; at < lines.length; at += 3) starts.push({argc: Number(value(lines[at], 'argc')), cwd: value(lines[at + 1], 'cwd'), arg1: value(lines[at + 2], 'arg1')});
  return starts;
}

/** Rows of `index|pane|name|path`: tmux prints a tab as `_`, so the separator is a bar. shortcut: a window name with a bar is not told from its path, the case names its own windows. */
export function parseTmuxWindows(text: string): TmuxWindow[] {
  return text.split('\n').filter(Boolean).map(line => {
    const [index, paneId, name, ...path] = line.split('|');
    if (!/^\d+$/.test(index) || !/^%\d+$/.test(paneId ?? '') || name === undefined || !path.length) throw new Error('Unexpected tmux window row');
    return {index: Number(index), name, path: path.join('|'), paneId};
  });
}

/** Every start of the stub agent so far, oldest first. */
export async function agentStarts(endpoint: Endpoint) {
  return parseAgentStarts(await readFile(join(endpoint.directory, agentLaunchLog), 'utf8').catch(() => ''));
}

/** The windows of the owned tmux session, with the folder each one's pane is in. */
export async function tmuxWindows(endpoint: Endpoint) {
  const {stdout} = await run(join(endpoint.directory, 'bin/tmux'),
    ['-L', 'default', 'list-windows', '-t', `=${SESSION}`, '-F', '#{window_index}|#{pane_id}|#{window_name}|#{pane_current_path}'],
    {env: {PATH: '/usr/bin:/bin', HOME: endpoint.directory, LANG: 'C.UTF-8', TMUX_TMPDIR: join(endpoint.directory, 'tmux')}, timeout: 10_000});
  return parseTmuxWindows(stdout);
}

export const isDirectory = (path: string) => stat(path).then(info => info.isDirectory(), () => false);
/** The Git repository of the host that a New agent worktree is made from. */
export const hostRepository = (endpoint: Endpoint) => join(endpoint.directory, agentLaunchRepository);
/** Where the host lets the case make its folders, one per run. */
export const hostLaunchDirectory = (endpoint: Endpoint) => join(endpoint.directory, 'launch');

/** The worktrees Git lists for the host's repository: the main one first. */
export async function hostWorktrees(endpoint: Endpoint) {
  const {stdout} = await run('git', ['-C', hostRepository(endpoint), 'worktree', 'list', '--porcelain'], {env: {PATH: '/usr/bin:/bin', HOME: endpoint.directory}, timeout: 10_000});
  return stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
}
