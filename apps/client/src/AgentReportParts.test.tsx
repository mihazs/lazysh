// @vitest-environment jsdom
import {cleanup, render} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {ReportRowContent} from './AgentReportParts';
import type {AgentSession} from './agentReports';

afterEach(cleanup);
const row: AgentSession = {sessionId: 's1', agent: 'Claude Code', project: '/work/app', state: 'working', updatedAt: '2026-11-28T10:00:00.000Z', summary: 'Working in the background', paneId: null, eventCount: 3};
const text = (value: AgentSession) => render(<ReportRowContent row={value} now={Date.parse(value.updatedAt)} />).container.querySelector('.agent-row-body')?.textContent;

it('lists what still runs under the summary of a board row, and nothing for a row that runs nothing', () => {
  expect(text({...row, background: {agents: 2, workflows: 1}})).toContain('Working in the background2 sub-agents · 1 workflow');
  cleanup();
  expect(text(row)).toBe(text({...row, background: undefined}));
  expect(text(row)).not.toContain('sub-agent');
});
