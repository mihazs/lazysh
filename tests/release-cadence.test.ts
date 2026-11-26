import { afterAll, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cycles, render } from '../.github/scripts/release-cadence';
import { gitFixtureRoots, project, spawnText } from './support/gitFixture';

const roots = gitFixtureRoots('lazysh-release-cadence-test-');
afterAll(() => roots.cleanup());

const at = (minute: number) => new Date(Date.UTC(2026, 10, 24, 0, minute)).toISOString();
const prs = [{ number: 11, createdAt: at(0), mergedAt: at(7), mergeCommit: { oid: 'aaaaaaaa11' } }, { number: 12, createdAt: at(90), mergedAt: at(95), mergeCommit: { oid: 'bbbbbbbb22' } }];
const runs = [
  { databaseId: 2, headSha: 'bbbbbbbb22', status: 'completed', conclusion: 'success', attempt: 1, createdAt: at(95), updatedAt: at(135) },
  { databaseId: 1, headSha: 'aaaaaaaa11', status: 'completed', conclusion: 'success', attempt: 1, createdAt: at(7), updatedAt: at(52) },
  { databaseId: 3, headSha: 'cccccccc33', status: 'in_progress', conclusion: '', attempt: 1, createdAt: at(140), updatedAt: at(141) },
];
// `skipped` jobs carry equal timestamps; `publish` finishes last but is never the critical path.
const jobs: Record<number, { name: string; startedAt: string; completedAt: string }[]> = {
  1: [{ name: 'android', startedAt: at(8), completedAt: at(30) }, { name: 'desktop', startedAt: at(18), completedAt: at(51) }, { name: 'ios', startedAt: at(7), completedAt: at(7) }, { name: 'publish', startedAt: at(51), completedAt: at(52) }],
  2: [{ name: 'source-build', startedAt: at(100), completedAt: at(134) }, { name: 'publish', startedAt: at(134), completedAt: at(135) }],
};

test('each publish run is joined to its version PR with open time, publish time, wait, critical job and release gap', () => {
  const rows = cycles(prs, runs, run => jobs[run] ?? []);
  expect(rows.map(row => ({ pr: row.pr, result: row.result, prOpenMin: row.prOpenMin, publishMin: row.publishMin, prToReleaseMin: row.prToReleaseMin,
    queueMin: row.queueMin, critical: row.critical, criticalMin: row.criticalMin, sincePreviousMin: row.sincePreviousMin }))).toEqual([
    { pr: 11, result: 'success', prOpenMin: 7, publishMin: 45, prToReleaseMin: 52, queueMin: 1, critical: 'desktop', criticalMin: 33, sincePreviousMin: null },
    { pr: 12, result: 'success', prOpenMin: 5, publishMin: 40, prToReleaseMin: 45, queueMin: 5, critical: 'source-build', criticalMin: 34, sincePreviousMin: 83 },
    { pr: null, result: 'in_progress', prOpenMin: null, publishMin: null, prToReleaseMin: null, queueMin: null, critical: null, criticalMin: null, sincePreviousMin: null },
  ]);
  expect(render(cycles(prs, runs, run => jobs[run] ?? []))).toContain('version PR open -> merged 5   publish 40   version PR opened -> released 45   between releases 83');
});

test('the command reads gh and prints the table or JSON, and fails with gh\'s error', async () => {
  const { root, env } = await roots.create();
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(root, 'prs.json'), JSON.stringify(prs));
  await writeFile(join(root, 'runs.json'), JSON.stringify(runs));
  await writeFile(join(root, 'jobs1.json'), JSON.stringify({ jobs: jobs[1] }));
  await writeFile(join(root, 'jobs2.json'), JSON.stringify({ jobs: jobs[2] }));
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!/bin/sh
case "$1 $2" in
  "pr list") cat "${root}/prs.json" ;;
  "run list") cat "${root}/runs.json" ;;
  "run view") cat "${root}/jobs$3.json" ;;
  *) echo "unexpected gh $*" >&2; exit 4 ;;
esac
`, { mode: 0o700 });
  const script = join(project, '.github/scripts/release-cadence.ts');
  const table = await spawnText(project, ['bun', script, '--limit', '5'], { ...env, GH: gh });
  expect(table.code).toBe(0);
  expect(table.stdout).toContain('desktop (33)');
  expect(table.stdout).toContain('between releases 83');
  const json = await spawnText(project, ['bun', script, '--json'], { ...env, GH: gh });
  expect(JSON.parse(json.stdout).map((row: { run: number }) => row.run)).toEqual([1, 2, 3]);
  const bad = await spawnText(project, ['bun', script, '--limit', '0'], { ...env, GH: gh });
  expect([bad.code, bad.stderr]).toEqual([2, expect.stringContaining('usage')]);
  const broken = await spawnText(project, ['bun', script], { ...env, GH: join(bin, 'missing') });
  expect(broken.code).toBe(1);
});
