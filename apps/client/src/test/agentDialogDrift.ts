import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir, userInfo} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {liftDialog, type Lift} from '../agentDialogLift';
import {liftCodexDialog} from '../agentDialogLiftCodex';

/** Detects a vendor's redraw of its dialogs before a user does: runs the installed agent in a private tmux pane, opens the dialogs of its slash commands, reads the
 * pane the way the Agent view does and says which ones the dialog card can still lift. `bun apps/client/src/test/agentDialogDrift.ts` (see docs/agent-view.md). */
export type Expect = 'dialog' | 'unliftable' | 'visible';
export type AgentSpec = Readonly<{name: string; bin: string; lift: (screen: readonly string[]) => Lift;
  /** A dialog a person can open without a model call. `visible`: the card lifts it or says it waits in the terminal (it depends on the account). `none` is never right. */
  dialogs: readonly Readonly<{command: string; expect: Expect}>[]}>;
export const agents: readonly AgentSpec[] = [
  {name: 'Claude Code', bin: 'claude', lift: liftDialog, dialogs: [{command: '/model', expect: 'dialog'}, {command: '/theme', expect: 'dialog'}, {command: '/resume', expect: 'visible'},
    {command: '/config', expect: 'unliftable'}, {command: '/permissions', expect: 'unliftable'}, {command: '/status', expect: 'unliftable'}, {command: '/help', expect: 'unliftable'}]},
  {name: 'Codex', bin: 'codex', lift: liftCodexDialog, dialogs: [{command: '/model', expect: 'dialog'}, {command: '/permissions', expect: 'dialog'}, {command: '/review', expect: 'dialog'},
    {command: '/resume', expect: 'unliftable'}]},
];

export type Result = Readonly<{command: string; expect: Expect; found: Lift['kind']; ok: boolean; screen: readonly string[]}>;
export type Report = Readonly<{agent: string; version: string; /** The working directory of the pane, which the screens may name. */ cwd: string; results: readonly Result[]}>;
export type Options = Readonly<{cwd?: string; cols?: number; rows?: number; interval?: number; maxWait?: number; env?: NodeJS.ProcessEnv}>;

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const isOk = (expect: Expect, found: Lift['kind']) => found !== 'none' && (expect === 'visible' || expect === found);

/** What a report may keep of a recorded screen: the working directory (also as the agent abbreviates it with `~`), the home directory, the user name and e-mail
 * addresses are replaced, trailing blanks dropped. Look at a recorded screen before it is committed: an agent can print other account details. */
export const sanitize = (rows: readonly string[], cwd: string, home = homedir(), user = userInfo().username): string[] => rows.map(row => [[cwd, '~/…/work'], [cwd.replace(home, '~'), '~/…/work'],
  [home, '/home/user'], [user, 'user']].reduce((text, [from, to]) => text.split(from).join(to), row).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, 'user@example.com').trimEnd());

export async function checkAgent(spec: AgentSpec, options: Options = {}): Promise<Report> {
  const {cols = 100, rows = 40, interval = 400, maxWait = 15_000, env} = options;
  const socket = `lazysh-drift-${process.pid}-${Date.now()}`;
  const directory = options.cwd ?? mkdtempSync(join(tmpdir(), 'lazysh-drift-'));
  const run = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], {encoding: 'utf8', env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  const read = () => run('capture-pane', '-p', '-t', 'drift').split('\n');
  /** The screen once it has stopped changing for two reads. */
  const settled = async () => {
    let previous = '', still = 0;
    for (let waited = 0; waited < maxWait; waited += interval) {
      await pause(interval);
      const screen = read().join('\n');
      still = screen === previous && screen.trim() ? still + 1 : 0;
      previous = screen;
      if (still >= 2) break;
    }
    return read();
  };
  const version = (() => {try {return /\d+(?:\.\d+)+/.exec(execFileSync(spec.bin, ['--version'], {encoding: 'utf8', env: {...process.env, ...env}}))?.[0] ?? 'unknown';} catch {return 'unknown';}})();
  const results: Result[] = [];
  let socketPath = '';
  try {
    run('new-session', '-d', '-s', 'drift', '-x', String(cols), '-y', String(rows), '-c', directory, spec.bin);
    socketPath = run('display-message', '-p', '#{socket_path}').trim();
    let screen = await settled();
    // A folder trust prompt comes first in a new directory: answer it as a person would, with the option that trusts the folder.
    const first = spec.lift(screen);
    if (first.kind === 'dialog' && /trust/i.test([first.dialog.title, ...first.dialog.body].join(' '))) {
      const yes = first.dialog.options.findIndex(option => /^yes/i.test(option.label));
      const keys = yes < 0 ? [] : [...Array(Math.abs(yes - first.dialog.highlighted)).fill(yes > first.dialog.highlighted ? 'Down' : 'Up'), 'Enter'];
      if (keys.length) {run('send-keys', '-t', 'drift', ...keys); screen = await settled();}
    }
    for (const {command, expect} of spec.dialogs) {
      run('send-keys', '-t', 'drift', '-l', command);
      await pause(interval);
      run('send-keys', '-t', 'drift', 'Enter');
      screen = await settled();
      const found = spec.lift(screen).kind;
      results.push({command, expect, found, ok: isOk(expect, found), screen});
      // Leave the dialog before the next one: Escape closes it, a second one goes back out of a page that opened. Whether one is still open is read from
      // its footer (the last rows name Esc), not from the lift, which is what is being checked and says `none` for a footer it does not know.
      for (let attempt = 0; attempt < 3 && screen.slice(-6).some(row => /\besc\b/i.test(row)); attempt++) {run('send-keys', '-t', 'drift', 'Escape'); screen = await settled();}
    }
  } finally {
    try {run('kill-server');} catch {/* The server may already be gone. */}
    if (socketPath) rmSync(socketPath, {force: true});
    if (!options.cwd) rmSync(directory, {recursive: true, force: true});
  }
  return {agent: spec.name, version, cwd: directory, results};
}

/** One line per dialog and a verdict: what a person reads in the terminal or in a log. */
export function formatReport(report: Report): string {
  return [`${report.agent} ${report.version}`, ...report.results.map(result => `  ${result.ok ? 'ok  ' : 'FAIL'} ${result.command} ${result.found}${result.ok ? '' : ` (expected ${result.expect})`}`)].join('\n');
}
export const failed = (reports: readonly Report[]) => reports.some(report => report.results.some(result => !result.ok));

/** `--agent claude|codex` (default: every agent whose program is installed), `--record DIR` writes each screen, sanitized, as `AGENT-VERSION-COMMAND.txt`. Exit status 1 when a dialog is not as expected. */
export async function main(argv: readonly string[], specs: readonly AgentSpec[] = agents, write: (text: string) => void = text => process.stdout.write(`${text}\n`)): Promise<number> {
  const option = (name: string) => argv[argv.indexOf(name) + 1];
  const only = argv.includes('--agent') ? option('--agent') : undefined;
  const chosen = specs.filter(spec => !only || spec.bin === only || spec.name.toLowerCase().startsWith(only.toLowerCase()));
  if (!chosen.length) {write(`no agent matches ${only}`); return 1;}
  const reports: Report[] = [];
  for (const spec of chosen) {
    try {execFileSync(spec.bin, ['--version'], {stdio: 'ignore'});} catch {write(`${spec.name}: ${spec.bin} is not installed, skipped`); continue;}
    const report = await checkAgent(spec);
    reports.push(report);
    write(formatReport(report));
    const record = argv.includes('--record') ? option('--record') : undefined;
    if (record) {
      mkdirSync(record, {recursive: true});
      for (const result of report.results) writeFileSync(join(record, `${basename(spec.bin)}-${report.version}-${result.command.slice(1)}.txt`), `${sanitize(result.screen, report.cwd).join('\n')}\n`);
    }
  }
  return failed(reports) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main(process.argv.slice(2)).then(code => {process.exitCode = code;});
