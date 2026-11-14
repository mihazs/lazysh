import {appendFileSync, globSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

/** The tiers are the directories under specs/ (docs/reference/mobile-e2e-conventions.md). */
export const TIERS = ['smoke', 'regression', 'journeys'] as const;
export type Tier = (typeof TIERS)[number];
/** `only` runs the quarantined (@flaky) tests, `exclude` runs everything else; unset runs all of them, as a local run does. */
export type Quarantine = 'only' | 'exclude' | undefined;

const list = (value: string) => value.split(',').map(entry => entry.trim()).filter(Boolean);

/** LAZYSH_E2E_TIERS: a pull request runs smoke and regression, main adds journeys. */
export function tiers(value = process.env.LAZYSH_E2E_TIERS ?? 'smoke,regression'): Tier[] {
  const names = list(value);
  const unknown = names.filter(name => !(TIERS as readonly string[]).includes(name));
  if (unknown.length || !names.length) throw new Error(`LAZYSH_E2E_TIERS must list some of ${TIERS.join(', ')}; got "${value}"`);
  return names as Tier[];
}

/** LAZYSH_E2E_FLAKY: `only` or `exclude`; see {@link Quarantine}. */
export function quarantine(value = process.env.LAZYSH_E2E_FLAKY): Quarantine {
  if (!value) return undefined;
  if (value !== 'only' && value !== 'exclude') throw new Error(`LAZYSH_E2E_FLAKY must be "only" or "exclude"; got "${value}"`);
  return value;
}

/** Mocha's title filter for the quarantine tag; it is per test, so a describe tagged @flaky moves all its tests. */
export const mochaGrep = (mode: Quarantine) => (mode ? {grep: '@flaky', invert: mode === 'exclude'} : {});

/** LAZYSH_E2E_SHARD=x/y (one-based) splits the spec files over y jobs; one emulator serves one session, so each shard is its own job. */
export function shard(value = process.env.LAZYSH_E2E_SHARD): {current: number; total: number} | undefined {
  if (!value) return undefined;
  const [current, total] = value.split('/').map(Number);
  if (!Number.isInteger(current) || !Number.isInteger(total) || current < 1 || current > total) throw new Error(`LAZYSH_E2E_SHARD must look like 1/2 (one-based, x of y); got "${value}"`);
  return {current, total};
}

/** The spec files of the tiers, sorted. Quarantine `only` keeps the files that mention @flaky, so a run never opens a session for nothing. */
export function specsFor(root: string, selected: Tier[], mode: Quarantine) {
  const files = selected.flatMap(tier => globSync('**/*.e2e.ts', {cwd: join(root, 'specs', tier)}).map(file => join(root, 'specs', tier, file))).sort();
  return mode === 'only' ? files.filter(file => readFileSync(file, 'utf8').includes('@flaky')) : files;
}

/**
 * Spec files that failed on an earlier attempt and passed on a later one. The launcher reports each worker's end with its exit
 * code, and specFileRetries starts the retry as a fresh worker for the same file, so the outcome of one file is its last report.
 */
export class Attempts {
  private readonly failed = new Set<string>();

  /** Records one worker's end; returns the files that this attempt just proved flaky. */
  record(specs: readonly string[], exitCode: number) {
    const flaky = exitCode === 0 ? specs.filter(spec => this.failed.has(spec)) : [];
    if (exitCode !== 0) specs.forEach(spec => this.failed.add(spec));
    flaky.forEach(spec => this.failed.delete(spec));
    return flaky;
  }
}

/** The job-summary lines for specs that passed only on their retry (GITHUB_STEP_SUMMARY is Markdown). */
export function flakySummary(label: string, flaky: readonly string[], root: string) {
  // The launcher names a spec file as a file:// URL.
  const path = (spec: string) => (spec.startsWith('file:') ? fileURLToPath(spec) : spec);
  return [`### Appium ${label} run: passed only on retry`, ...flaky.map(spec => `- \`${relative(root, path(spec))}\``), ''].join('\n');
}

/** Appends the summary to the CI job summary when there is one, and always warns on the console. */
export function reportFlaky(label: string, flaky: readonly string[], root: string, summaryFile = process.env.GITHUB_STEP_SUMMARY) {
  if (!flaky.length) return;
  const text = flakySummary(label, flaky, root);
  console.warn(`${text}\nOpen or update a flaky-test issue the same day (docs/reference/mobile-e2e-conventions.md).`);
  if (summaryFile) appendFileSync(summaryFile, `${text}\n`);
}
