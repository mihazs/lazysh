import { expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const metadata = Bun.spawnSync(['cargo', 'metadata', '--no-deps', '--format-version', '1'], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
expect(metadata.exitCode).toBe(0);
const binary = process.env.LAZYSH_TEST_COMPANION_BINARY ?? join(JSON.parse(metadata.stdout.toString()).target_directory, 'debug', `lazysh-agent${process.platform === 'win32' ? '.exe' : ''}`);
expect(isAbsolute(binary)).toBe(true);
expect(lstatSync(binary).isFile()).toBe(true);
expect(lstatSync(binary).isSymbolicLink()).toBe(false);

test('actual CLI prints distinct Gemini, Droid, Kimi and Copilot formats without changing profiles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lazysh-hook-config-'));
  try {
    for (const [agent, events] of [
      ['gemini', ['BeforeAgent', 'BeforeTool', 'AfterTool', 'Notification', 'AfterAgent', 'SessionEnd']],
      ['droid', ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']],
      ['kimi', ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SessionEnd']],
      ['copilot', ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd', 'notification']],
      ['cursor', ['beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'afterAgentThought', 'stop', 'sessionEnd']],
    ] as const) {
      const output = Bun.spawnSync([binary, `${agent}-config`], { cwd: directory, env: { ...process.env, LAZYSH_STATE_DIR: join(directory, 'state'), GEMINI_CONFIG_DIR: join(directory, 'gemini'), FACTORY_CONFIG_DIR: join(directory, 'factory'), KIMI_CONFIG_FILE: join(directory, 'kimi.toml') }, stdout: 'pipe', stderr: 'pipe' });
      expect(output.exitCode).toBe(0);
      expect(output.stderr.toString()).toBe('');
      const printed = JSON.parse(output.stdout.toString());
      if (agent === 'kimi') {
        expect(printed.filename).toBe('config.toml');
        expect(printed.format).toBe('toml');
        expect(Bun.TOML.parse(printed.content)).toEqual({ hooks: events.map(event => ({ event, command: 'lazysh-agent ingest --agent kimi', timeout: 5 })) });
      } else {
        const hooks = agent === 'droid' ? printed : printed.hooks;
        expect(Object.keys(hooks)).toEqual([...events].sort());
        if (agent === 'droid') expect(printed.hooks).toBeUndefined();
        if (agent === 'cursor') expect(printed.version).toBe(1);
        if (agent === 'copilot') { expect(printed.version).toBe(1); expect(hooks.preToolUse).toBeUndefined(); expect(hooks.permissionRequest).toBeUndefined(); }
        for (const event of events) {
          expect(hooks[event]).toEqual(agent === 'cursor' ? [{ command: 'lazysh-agent ingest --agent cursor', timeout: 5 }] : agent === 'copilot' ? [{ type: 'command', exec: 'lazysh-agent', args: ['ingest', '--agent', 'copilot'], timeoutSec: 5 }] : [{ hooks: [{ type: 'command', command: `lazysh-agent ingest --agent ${agent}`, timeout: agent === 'gemini' ? 5000 : 5 }] }]);
        }
      }
      expect(readdirSync(directory)).toEqual([]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('actual CLI prints the exact Amp asset and truthful Aider arguments without installing anything', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lazysh-observer-config-'));
  try {
    for (const command of ['amp-plugin', 'cline-plugin', 'aider-config']) {
      const output = Bun.spawnSync([binary, command], { cwd: directory, env: { ...process.env, LAZYSH_STATE_DIR: join(directory, 'state') }, stdout: 'pipe', stderr: 'pipe' });
      expect(output.exitCode).toBe(0);
      expect(output.stderr.toString()).toBe('');
      const printed = JSON.parse(output.stdout.toString());
      if (command === 'cline-plugin') {
        expect(printed).toEqual({ schemaVersion: 1, filename: 'lazysh.js', scope: 'root-only', content: await Bun.file(join(import.meta.dir, 'cline.js')).text() });
      } else if (command === 'amp-plugin') {
        expect(printed).toEqual({ schemaVersion: 1, filename: 'lazysh.js', content: await Bun.file(join(import.meta.dir, 'amp.js')).text() });
      } else {
        expect(printed.arguments).toEqual(['--notifications', '--notifications-command', 'lazysh-agent aider-notification']);
        expect(printed.sessionAttribution).toBe('unavailable');
        expect(printed.lifecycleStates).toEqual([]);
      }
      expect(readdirSync(directory)).toEqual([]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
