import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './support/gitFixture';
import { plannedTargets } from './support/moon';
import { document, evaluate, executedSteps, interpolate, runnerJobs, type Context } from './support/workflowGraph';

const verdict = '.github/workflows/main-verdict.yml';
const push = (sha: string): Context => ({ github: { event_name: 'push', ref: 'refs/heads/main', workflow: 'main-verdict', sha }, inputs: {} });
const sha = (digit: string) => digit.repeat(40);

test('every main commit has its own verdict run that a newer push never cancels', async () => {
  const workflow = await document(verdict);
  expect(workflow.on).toEqual({ push: { branches: ['main'] } });
  const group = (commit: string) => interpolate(workflow.concurrency.group, push(commit));
  expect(group(sha('a'))).toBe(group(sha('a')));
  expect(group(sha('a'))).not.toBe(group(sha('b')));
  expect(evaluate(workflow.concurrency['cancel-in-progress'], push(sha('a')))).toBe(false);
});

test('the verdict runs three bounded, independent jobs whose check names cannot satisfy a required check', async () => {
  const jobs = await runnerJobs(verdict, push(sha('a')));
  expect(jobs.map(entry => entry.id).sort()).toEqual(['agent', 'client', 'release-tools']);
  for (const entry of jobs) {
    expect([entry.id, entry.queueEntry, entry.rows.length]).toEqual([entry.id, 1, 1]);
    expect(entry.job['timeout-minutes']).toBeLessThanOrEqual(20);
  }
  // A required status check matches by check-run name, so a verdict job must never reuse another job's name.
  const names = new Map<string, string[]>();
  for (const file of (await readdir(join(project, '.github/workflows'))).filter(name => name.endsWith('.yml'))) {
    for (const [id, job] of Object.entries<any>((await document(`.github/workflows/${file}`)).jobs)) {
      const name = String(job.name ?? id).toLowerCase();
      names.set(name, [...names.get(name) ?? [], `${file}#${id}`]);
    }
  }
  for (const entry of jobs) expect(names.get(String(entry.job.name).toLowerCase())).toEqual([`main-verdict.yml#${entry.id}`]);
});

test('the verdict plans only the client build and the companion compile checks, never a test or native task', async () => {
  const jobs = await runnerJobs(verdict, push(sha('a')));
  const targets: string[] = [];
  for (const entry of jobs) for (const { step } of await executedSteps(entry.job.steps, entry.context)) {
    for (const match of String(step.run ?? '').matchAll(/moon run ([^\n]+)/g)) {
      targets.push(...match[1].split(/\s+/).map(token => token.replaceAll("'", '')).filter(token => token.includes(':')));
    }
  }
  expect(targets.sort()).toEqual(['#companion:check-rust', 'client:build']);
  const planned = await plannedTargets(...targets);
  expect(planned).toContain('client:build');
  expect(planned).toContain('agent:check-rust');
  for (const target of planned) expect(target).toMatch(/^[\w-]+:(build|check-rust|sources)$/);
});

test('the release-tools verdict runs the same commands as the version workflow job that guards the version PR', async () => {
  const commands = async (file: string) => (await executedSteps((await document(file)).jobs['release-tools'].steps, push(sha('a'))))
    .flatMap(({ step }) => step.uses ?? String(step.run).split('\n').map(line => line.trim()).filter(Boolean));
  expect(await commands(verdict)).toEqual(await commands('.github/workflows/version.yml'));
});
