import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {liftDialog} from './agentDialogLift';
import {checkAgent, failed, formatReport, main, sanitize, type AgentSpec} from './test/agentDialogDrift';
import {dialogScreen} from './test/agentDialogScreens';

const hasTmux = (() => {try {execFileSync('tmux', ['-V'], {stdio: 'ignore'}); return true;} catch {return false;}})();
/** A program that draws a screen when it is typed a slash command and goes back to its prompt on Escape, in a real terminal: what the check drives in place of an agent. */
const program = `#!/usr/bin/env node
if (process.argv[2] === '--version') {console.log('fake 9.9.9'); process.exit(0);}
const screens = JSON.parse(process.env.FAKE_SCREENS);
const draw = rows => process.stdout.write('\\x1b[2J\\x1b[H' + rows.slice(0, 40).join('\\r\\n'));
process.stdin.setRawMode(true); process.stdin.resume();
draw(['fake agent ready']);
let line = '';
process.stdin.on('data', chunk => {for (const key of chunk.toString()) {
  if (key === '\\x1b') draw(['fake agent ready']);
  else if (key === '\\r') {if (screens[line]) draw(screens[line].map(row => row.replace('{cwd}', process.cwd()).replace('{home}', process.env.HOME))); line = '';}
  else line += key;
}});
`;
const model = dialogScreen('model'), tabs = dialogScreen('permissions-tabs');
let directory: string;
const spec = (dialogs: AgentSpec['dialogs']): AgentSpec => ({name: 'Fake', bin: join(directory, 'fake-agent'), lift: liftDialog, dialogs});
const options = (screens: Record<string, string[]>) => ({interval: 150, maxWait: 4000, env: {FAKE_SCREENS: JSON.stringify(screens)}});

// Each dialog takes a few reads of a real pane to settle.
const timeout = 30_000;
describe.skipIf(!hasTmux)('the dialog drift check, against a program in a real tmux pane', () => {
  beforeAll(() => {directory = mkdtempSync(join(tmpdir(), 'lazysh-drift-test-')); writeFileSync(join(directory, 'fake-agent'), program); chmodSync(join(directory, 'fake-agent'), 0o755);});
  afterAll(() => rmSync(directory, {recursive: true, force: true}));

  it('reports the version and every dialog that is as expected, and does not fail', async () => {
    const report = await checkAgent(spec([{command: '/model', expect: 'dialog'}, {command: '/tabs', expect: 'unliftable'}, {command: '/either', expect: 'visible'}]), options({'/model': model, '/tabs': tabs, '/either': tabs}));
    expect(formatReport(report)).toBe(['Fake 9.9.9', '  ok   /model dialog', '  ok   /tabs unliftable', '  ok   /either unliftable'].join('\n'));
    expect(failed([report])).toBe(false);
  }, timeout);

  it('names the dialog and the version when a redraw makes a dialog that must lift unreadable', async () => {
    const redrawn = model.map(row => row.replace('Enter to set as default', 'Return to set as default'));
    const report = await checkAgent(spec([{command: '/model', expect: 'dialog'}, {command: '/tabs', expect: 'unliftable'}]), options({'/model': redrawn, '/tabs': tabs}));
    expect(formatReport(report)).toBe(['Fake 9.9.9', '  FAIL /model unliftable (expected dialog)', '  ok   /tabs unliftable'].join('\n'));
    expect(failed([report])).toBe(true);
  }, timeout);

  it('never accepts a dialog the card does not see at all', async () => {
    const report = await checkAgent(spec([{command: '/quiet', expect: 'visible'}]), options({'/quiet': ['  Some text', '', '  and no way to leave it']}));
    expect(formatReport(report)).toBe(['Fake 9.9.9', '  FAIL /quiet none (expected visible)'].join('\n'));
  }, timeout);

  it('exits 0 or 1, prints the report, and records sanitized screens when asked', async () => {
    const screens = {'/model': [...model.slice(0, 20), '  cwd {cwd} home {home} owner someone@example.org', ...model.slice(21)]};
    const lines: string[] = [], record = join(directory, 'recorded');
    const [good, bad] = [spec([{command: '/model', expect: 'dialog'}]), spec([{command: '/model', expect: 'unliftable'}])];
    // `main` takes the program's name from the spec, so the fake is found by its path.
    const env = process.env.FAKE_SCREENS;
    process.env.FAKE_SCREENS = JSON.stringify(screens);
    try {
      expect(await main(['--agent', good.bin, '--record', record], [good], text => lines.push(text))).toBe(0);
      expect(await main(['--agent', bad.bin], [bad], text => lines.push(text))).toBe(1);
      expect(await main(['--agent', 'nothing'], [good], text => lines.push(text))).toBe(1);
    } finally {if (env === undefined) delete process.env.FAKE_SCREENS; else process.env.FAKE_SCREENS = env;}
    expect(lines).toEqual(['Fake 9.9.9\n  ok   /model dialog', 'Fake 9.9.9\n  FAIL /model dialog (expected unliftable)', 'no agent matches nothing']);
    const [file] = readdirSync(record);
    expect(file).toBe(`fake-agent-9.9.9-model.txt`);
    const text = readFileSync(join(record, file), 'utf8');
    expect(text).toContain('cwd ~/…/work home /home/user owner user@example.com');
    expect(text).not.toContain(homedir());
  }, timeout);
});

describe('sanitize', () => {
  it('keeps no working directory, home directory or e-mail address of the machine it was recorded on', () => {
    expect(sanitize(['  cwd /home/alice/proj/x  ', '  ~/proj/x · -home-alice-dev', '  /home/alice/.config and a.b+c@mail.example.co.uk'], '/home/alice/proj/x', '/home/alice', 'alice'))
      .toEqual(['  cwd ~/…/work', '  ~/…/work · -home-user-dev', '  /home/user/.config and user@example.com']);
  });
});
