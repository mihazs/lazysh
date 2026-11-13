// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {groupTurns, parseTranscript} from '../src/ChatPanel';
import {projectMessages} from '../src/chatInjected';
import typical from './fixtures/agent-page-typical.json';
import heavy from './fixtures/agent-page-heavy.json';

// Guardrails for the client's work on a page the companion recorded (docs/reference/agent-view-performance.md). Validating, projecting
// and grouping a page takes under a millisecond on a desktop core; the time budget is fifty times that, so it fails on a regression of
// the kind that matters (a quadratic pass, a re-parse per message) and not on a slow CI machine. The structural budgets are exact.
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function load(page: unknown) {
  const parsed = parseTranscript(structuredClone(page));
  return groupTurns(projectMessages(parsed.messages));
}

describe.each([['typical', typical, 100], ['heavy', heavy, 40]] as const)('the %s recorded page', (_name, page, least) => {
  it('is a real companion page: the newest messages of a long session, with older ones behind it', () => {
    expect(page.messages.length).toBeGreaterThanOrEqual(least);
    expect((page as {truncated?: boolean}).truncated).toBe(true);
  });

  it('is validated, projected and grouped into turns within the budget', () => {
    const runs: number[] = [];
    for (let run = 0; run < 7; run++) {
      const started = performance.now();
      load(page);
      runs.push(performance.now() - started);
    }
    expect(median(runs)).toBeLessThan(30);
  });

  it('groups every message into a turn and keeps each tool call with its result', () => {
    const turns = load(page);
    const grouped = turns.reduce((count, turn) => count + (turn.event ? 1 : 0) + (turn.prompt ? 1 : 0) + turn.activity.length + (turn.answer ? 1 : 0), 0);
    expect(grouped).toBe(page.messages.length);
    expect(turns.length).toBeGreaterThan(3);
  });
});
