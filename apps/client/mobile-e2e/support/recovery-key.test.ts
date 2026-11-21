import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {redactRecoveryKey} from './recovery-key';
import {SecureValuesPreprocessor} from '@appium/logger/build/lib/secure-values-preprocessor';

test('recovery keys are removed from WebDriver text, arrays and XML without hiding unrelated output', async () => {
  const secret = `LAZYSH-SYNC-V1-${'ab'.repeat(32)}`;
  const characters = JSON.stringify([...secret]);
  const log = `response ${secret}\nrequest {"text":"${secret}","value":${characters}}\nxml ${characters.replaceAll('"', '&quot;')}\nremaining diagnostic`;
  const redacted = redactRecoveryKey(log);
  expect(redacted).not.toContain(secret);
  expect(redacted).not.toContain(characters);
  expect(redacted).not.toContain(characters.replaceAll('"', '&quot;'));
  expect(redacted).toContain('remaining diagnostic');
  expect(redactRecoveryKey('LAZYSH-SYNC-V1-ab12')).not.toContain('ab12');

  const filters: {pattern: string; flags: string; replaceWith: string}[] = JSON.parse(readFileSync(new URL('../appium-log-filters.json', import.meta.url), 'utf8'));
  const preprocessor = new SecureValuesPreprocessor();
  expect(await preprocessor.loadRules(filters)).toEqual([]);
  const appium = preprocessor.preprocess(log);
  expect(appium).not.toContain(secret);
  expect(appium).not.toContain(characters);
  expect(appium).toContain('remaining diagnostic');
});

test('the JUnit reporter redacts WebDriver command output before writing XML', async () => {
  const {PassThrough} = await import('node:stream');
  const {default: SafeJunitReporter} = await import('./safe-junit');
  const stream = new PassThrough();
  let output = '';
  stream.on('data', chunk => { output += chunk.toString(); });
  const reporter = new SafeJunitReporter({stdout: true, writeStream: stream});
  const secret = `LAZYSH-SYNC-V1-${'42'.repeat(32)}`;
  reporter.write(`<system-out>COMMAND: ${JSON.stringify({text: secret, value: [...secret]})}</system-out>`);
  expect(output).not.toContain(secret);
  expect(output).not.toContain(JSON.stringify([...secret]));
  expect(output).toContain('[redacted sync recovery key]');
});
