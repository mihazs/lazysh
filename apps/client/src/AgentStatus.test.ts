import {expect,it} from 'vitest';
import {agentKind} from './AgentStatus';

it('derives compact agent tags without losing unknown agents',()=>{
  expect(agentKind('Claude Code')).toBe('claude');
  expect(agentKind('codex')).toBe('codex');
  expect(agentKind('Mystery agent')).toBe('other');
  expect(agentKind(null)).toBe('other');
});
