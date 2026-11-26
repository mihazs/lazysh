import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('rejects a malformed Android package ID before calling adb', () => {
  const result = spawnSync('bun', [join(import.meta.dirname, 'androidNativeBench.ts')], {
    encoding: 'utf8',
    env: { ...process.env, LAZYSH_LANE_PACKAGE: 'app.lazysh; invalid' },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Invalid Android benchmark package ID');
});
