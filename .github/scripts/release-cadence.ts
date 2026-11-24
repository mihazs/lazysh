// Usage: bun .github/scripts/release-cadence.ts [--limit N] [--json]   (needs an authenticated `gh`; GH_REPO selects the repository)
// Prints one row per recent "Verified stable tag" publish run, joined to the Changesets version PR it published: how long the version
// PR stayed open, how long publication took (and how long the first job waited for a runner), which job finished last (the
// critical path), reruns, and the gap to the previous release. Read-only: it only calls `gh pr list`, `gh run list` and `gh run view`.
export interface Pr { number: number; createdAt: string; mergedAt: string; mergeCommit: { oid: string } | null }
export interface Run { databaseId: number; headSha: string; status: string; conclusion: string; attempt: number; createdAt: string; updatedAt: string }
export interface Job { name: string; startedAt: string; completedAt: string }
export interface Cycle { pr: number | null; run: number; sha: string; result: string; attempts: number; prOpenMin: number | null; publishMin: number | null; prToReleaseMin: number | null;
  queueMin: number | null; critical: string | null; criticalMin: number | null; sincePreviousMin: number | null }

const minutes = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 6000) / 10;
const valid = (stamp: string) => Date.parse(stamp) > Date.parse('2000-01-01');

/** Join publish runs to their version PRs and derive each release cycle; pure so tests can feed controlled data. */
export function cycles(prs: Pr[], runs: Run[], jobsOf: (run: number) => Job[]): Cycle[] {
  const rows: Cycle[] = [];
  let previous: Run | undefined;
  for (const run of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const pr = prs.find(candidate => candidate.mergeCommit?.oid === run.headSha);
    const done = run.status === 'completed';
    // A skipped job has no real start or a zero duration; it is neither a wait nor a critical path.
    const jobs = done ? jobsOf(run.databaseId).filter(job => valid(job.startedAt) && valid(job.completedAt) && job.completedAt > job.startedAt) : [];
    // The last job to finish decides when `publish` can start; `publish` itself is excluded.
    const last = jobs.filter(job => job.name !== 'publish').sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    const released = done && run.conclusion === 'success';
    rows.push({ pr: pr?.number ?? null, run: run.databaseId, sha: run.headSha.slice(0, 8), result: done ? run.conclusion : run.status, attempts: run.attempt,
      prOpenMin: pr ? minutes(pr.createdAt, pr.mergedAt) : null, publishMin: done ? minutes(run.createdAt, run.updatedAt) : null,
      prToReleaseMin: pr && released ? minutes(pr.createdAt, run.updatedAt) : null,
      queueMin: jobs.length ? Math.min(...jobs.map(job => minutes(run.createdAt, job.startedAt))) : null,
      critical: last?.name ?? null, criticalMin: last ? minutes(last.startedAt, last.completedAt) : null,
      sincePreviousMin: released && previous ? minutes(previous.updatedAt, run.updatedAt) : null });
    if (released) previous = run;
  }
  return rows;
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };
const cell = (value: number | string | null, width: number) => String(value ?? '-').slice(0, width).padEnd(width);

export function render(rows: Cycle[]) {
  const head = `${cell('PR', 6)}${cell('run', 12)}${cell('result', 12)}${cell('tries', 6)}${cell('PR open', 8)}${cell('publish', 8)}${cell('PR->rel', 8)}${cell('queue', 7)}${cell('gap', 7)}critical job (min)`;
  const lines = rows.map(row => `${cell(row.pr, 6)}${cell(row.run, 12)}${cell(row.result, 12)}${cell(row.attempts, 6)}${cell(row.prOpenMin, 8)}${cell(row.publishMin, 8)}${cell(row.prToReleaseMin, 8)}${cell(row.queueMin, 7)}${cell(row.sincePreviousMin, 7)}${row.critical ?? '-'} (${row.criticalMin ?? '-'})`);
  const of = (pick: (row: Cycle) => number | null) => median(rows.flatMap(row => row.result === 'success' && pick(row) !== null ? [pick(row)!] : []));
  return [head, ...lines, '', 'minutes; median over successful releases:',
    `  version PR open -> merged ${of(row => row.prOpenMin)}   publish ${of(row => row.publishMin)}   version PR opened -> released ${of(row => row.prToReleaseMin)}   between releases ${of(row => row.sincePreviousMin)}`].join('\n');
}

async function gh(...args: string[]) {
  const child = Bun.spawn([process.env.GH ?? 'gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`gh ${args.join(' ')} failed (${code}): ${err.trim()}`);
  return JSON.parse(out);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--limit'), limit = at < 0 ? 12 : Number(argv[at + 1]);
  if (!Number.isInteger(limit) || limit < 1) { console.error('usage: release-cadence.ts [--limit N] [--json]'); process.exit(2); }
  try {
    const prs: Pr[] = await gh('pr', 'list', '--head', 'changeset-release/main', '--state', 'merged', '--limit', String(limit * 2), '--json', 'number,createdAt,mergedAt,mergeCommit');
    const runs: Run[] = await gh('run', 'list', '--workflow', 'Verified stable tag', '--limit', String(limit), '--json', 'databaseId,headSha,status,conclusion,attempt,createdAt,updatedAt');
    const jobs = new Map<number, Job[]>();
    for (const run of runs) if (run.status === 'completed') jobs.set(run.databaseId, (await gh('run', 'view', String(run.databaseId), '--json', 'jobs')).jobs);
    const rows = cycles(prs, runs, run => jobs.get(run) ?? []);
    console.log(argv.includes('--json') ? JSON.stringify(rows, null, 2) : render(rows));
  } catch (error) { console.error(String(error instanceof Error ? error.message : error)); process.exit(1); }
}
