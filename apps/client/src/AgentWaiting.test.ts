import {expect,it} from 'vitest';
import {waitingFirst,waitingKind} from './AgentWaiting';

const report=(summary:string,state='needs_attention',updatedAt='2026-11-10T10:00:00Z',agent='Claude Code',extra:object={})=>({agent,state,summary,updatedAt,...extra}) as Parameters<typeof waitingKind>[0];

it.each([
  ['Bash','approval'],['Permission requested','approval'],['AskUserQuestion','question'],['request_user_input','question'],
  ['Answer requested','question'],['ExitPlanMode','plan'],['Agent needs attention','unknown'],
])('names what a %s report waits for as %s',(summary,kind)=>expect(waitingKind(report(summary))).toBe(kind));

it('does not call another agent\'s free-form summary an approval',()=>{
  expect(waitingKind(report('Needs review','needs_attention','2026-11-10T10:00:00Z','Cursor CLI'))).toBe('unknown');
  expect(waitingKind(report('Permission requested','needs_attention','2026-11-10T10:00:00Z','Gemini CLI'))).toBe('approval');
});

it('does not call a failure or a moved-on report a wait',()=>{
  expect(waitingKind(report('Turn failed'))).toBeUndefined();expect(waitingKind(report('Session error'))).toBeUndefined();
  expect(waitingKind(report('Bash','working'))).toBeUndefined();expect(waitingKind(report('Bash','done'))).toBeUndefined();
});

it('lists waiting sessions first, longest waiting first, and keeps the order of the rest',()=>{
  const rows=[report('Working','working','2026-11-10T10:05:00Z'),report('Bash','needs_attention','2026-11-10T10:03:00Z'),report('Done','done','2026-11-10T10:04:00Z'),report('AskUserQuestion','needs_attention','2026-11-10T10:01:00Z')];
  expect(waitingFirst(rows).map(row=>row.summary)).toEqual(['AskUserQuestion','Bash','Working','Done']);
});

it('trusts what the companion recorded over the summary and counts the wait from its start',()=>{
  // A notification overwrote the tool name in the summary; the recorded kind still says what the agent waits for.
  expect(waitingKind(report('Agent needs attention','needs_attention','2026-11-10T10:09:00Z','Claude Code',{waiting:'question'}))).toBe('question');
  expect(waitingKind(report('AskUserQuestion','working','2026-11-10T10:09:00Z','Claude Code',{waiting:'question'}))).toBeUndefined();
  const rows=[report('Bash','needs_attention','2026-11-10T10:09:00Z','Claude Code',{waitingSince:'2026-11-10T10:00:00Z'}),report('Bash','needs_attention','2026-11-10T10:05:00Z')];
  expect(waitingFirst(rows)).toEqual(rows);
});
