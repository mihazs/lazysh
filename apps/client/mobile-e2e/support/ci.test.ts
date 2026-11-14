import {afterEach, beforeEach, expect, test} from 'bun:test';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Attempts, flakySummary, mochaGrep, quarantine, reportFlaky, shard, specsFor, tiers} from './ci';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'lazysh-ci-specs-')); });
afterEach(() => rm(root, {recursive: true, force: true}));
const spec = async (path: string, text = 'describe("x", () => {});') => {
  await mkdir(dirname(join(root, 'specs', path)), {recursive: true});
  await writeFile(join(root, 'specs', path), text);
  return join(root, 'specs', path);
};

test('a pull request runs smoke and regression; main adds journeys; anything else is refused', () => {
  expect(tiers(undefined)).toEqual(['smoke', 'regression']);
  expect(tiers('smoke, regression ,journeys')).toEqual(['smoke', 'regression', 'journeys']);
  for (const bad of ['', 'smokes', 'smoke,all']) expect(() => tiers(bad)).toThrow('LAZYSH_E2E_TIERS');
});

test('the shard is one-based x/y and anything else is refused', () => {
  expect(shard(undefined)).toBeUndefined();
  expect(shard('2/3')).toEqual({current: 2, total: 3});
  for (const bad of ['0/2', '3/2', '1', 'a/b', '1.5/2']) expect(() => shard(bad)).toThrow('LAZYSH_E2E_SHARD');
});

test('the quarantine run and the gating run select disjoint tests by the @flaky tag', () => {
  expect(mochaGrep(quarantine(''))).toEqual({});
  expect(mochaGrep(quarantine('only'))).toEqual({grep: '@flaky', invert: false});
  expect(mochaGrep(quarantine('exclude'))).toEqual({grep: '@flaky', invert: true});
  expect(() => quarantine('both')).toThrow('LAZYSH_E2E_FLAKY');
});

test('spec files come from the chosen tiers only; the quarantine run opens a session only for files that mention @flaky', async () => {
  const smoke = await spec('smoke/launch.e2e.ts');
  const scroll = await spec('regression/scroll/1402-swipe.e2e.ts', 'describe("Swipe @flaky", () => {});');
  const keyboard = await spec('regression/keyboard/1198-last-row.e2e.ts');
  const journey = await spec('journeys/long.e2e.ts');
  await spec('smoke/notes.md', 'not a spec');
  expect(specsFor(root, ['smoke', 'regression'], undefined)).toEqual([keyboard, scroll, smoke].sort());
  expect(specsFor(root, ['smoke', 'regression', 'journeys'], 'exclude')).toEqual([journey, keyboard, scroll, smoke].sort());
  expect(specsFor(root, ['smoke', 'regression', 'journeys'], 'only')).toEqual([scroll]);
  expect(specsFor(root, ['smoke'], 'only')).toEqual([]);
});

test('only a spec file that failed first and then passed counts as flaky, once', () => {
  const attempts = new Attempts();
  expect(attempts.record(['a.e2e.ts'], 0)).toEqual([]);
  expect(attempts.record(['b.e2e.ts'], 1)).toEqual([]); // retried
  expect(attempts.record(['c.e2e.ts'], 1)).toEqual([]);
  expect(attempts.record(['b.e2e.ts'], 0)).toEqual(['b.e2e.ts']); // passed on the retry
  expect(attempts.record(['c.e2e.ts'], 1)).toEqual([]); // failed on both attempts: a real failure, not a flake
  expect(attempts.record(['b.e2e.ts'], 0)).toEqual([]);
});

test('the job summary names each flaky spec relative to the suite, and nothing is written when none were', async () => {
  const file = join(root, 'summary.md');
  const flaky = join(root, 'specs/smoke/launch.e2e.ts');
  expect(flakySummary('gating', [flaky], root)).toBe('### Appium gating run: passed only on retry\n- `specs/smoke/launch.e2e.ts`\n');
  expect(flakySummary('gating', [pathToFileURL(flaky).href], root)).toBe(flakySummary('gating', [flaky], root));
  const warn = console.warn;
  console.warn = () => {};
  try {
    reportFlaky('gating', [], root, file);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
    reportFlaky('gating', [flaky], root, file);
    reportFlaky('quarantine', [flaky], root, file);
  } finally { console.warn = warn; }
  const written = await readFile(file, 'utf8');
  expect(written).toContain('### Appium gating run: passed only on retry');
  expect(written).toContain('### Appium quarantine run: passed only on retry');
});
