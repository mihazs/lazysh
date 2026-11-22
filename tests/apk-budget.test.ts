import { expect, test } from 'bun:test';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageMaximumBytes } from '../.changeset/release-artifacts';

const script = new URL('../.github/scripts/apk-budget.ts', import.meta.url).pathname;
const run = async (target: string, bytes: number) => {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-apk-budget-'));
  try {
    const apk = join(directory, 'app.apk');
    await writeFile(apk, '');
    await truncate(apk, bytes);
    const child = Bun.spawn([process.execPath, script, target, apk], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    return { exit: await child.exited, stdout: await new Response(child.stdout).text() };
  } finally { await rm(directory, { recursive: true, force: true }); }
};

test('an APK at the ceiling passes and one byte over fails, naming both sizes', async () => {
  const limit = packageMaximumBytes('android-google-arm64', 'apk');
  expect(await run('android-google-arm64', limit)).toMatchObject({ exit: 0 });
  const over = await run('android-google-arm64', limit + 1);
  expect(over.exit).toBe(1);
  expect(over.stdout).toContain(`${limit + 1} bytes of ${limit} allowed`);
});
