import { expect, test } from 'bun:test';
import { document, evaluate } from './support/workflowGraph';

const osc52 = 'Exercise tmux, Zellij and Herdr copies reaching the device clipboard through OSC 52 consent';

/** Which steps run: a condition without a status function carries an implicit success(), so an earlier failure skips it. */
function ran(steps: any[], earlierFailure: boolean) {
  const outcomes: Record<string, { outcome: string }> = {};
  return steps.filter(step => {
    const condition = String(step.if ?? '');
    const runs = (!earlierFailure || /\b(always|cancelled|failure)\(\)/.test(condition))
      && (step.if === undefined || Boolean(evaluate(step.if, { steps: outcomes })));
    if (step.id) outcomes[step.id] = { outcome: runs ? 'success' : 'skipped' };
    return runs;
  });
}

test('the OSC 52 clipboard step of native-linux-runtimes runs exactly when its Playwright browser was installed', async () => {
  const { steps } = (await document('.github/workflows/checks.yml')).jobs['native-linux-runtimes'];
  const installs = (earlierFailure: boolean) => ran(steps, earlierFailure).filter(step => String(step.run).includes('playwright install')).length;
  const exercised = (earlierFailure: boolean) => ran(steps, earlierFailure).some(step => step.name === osc52);
  expect([installs(false), exercised(false)]).toEqual([1, true]);
  expect([installs(true), exercised(true)]).toEqual([0, false]);
  // The steps that need no browser still report after an earlier failure.
  expect(ran(steps, true).length).toBeGreaterThan(10);
});
