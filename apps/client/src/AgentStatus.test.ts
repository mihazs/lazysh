import {afterEach,expect,it} from 'vitest';
import {agentKind,formatRecency,projectName} from './AgentStatus';
import {uiI18n} from './i18n/core';

afterEach(async()=>{await uiI18n.changeLanguage('en');});

it('describes report recency in the active interface language and keeps old reports absolute',async()=>{
  const now=Date.parse('2026-10-29T12:05:00Z');
  await uiI18n.changeLanguage('en');
  expect(formatRecency('2026-10-29T12:04:50Z',now)).toBe('now');
  expect(formatRecency('2026-10-29T12:01:00Z',now)).toBe('4 min. ago');
  expect(formatRecency('2026-10-29T09:05:00Z',now)).toBe('3 hr. ago');
  expect(formatRecency('2026-10-01T12:05:00Z',now)).toMatch(/2026/);
  expect(formatRecency('not a time',now)).toBe('');
  await uiI18n.changeLanguage('pt-BR');
  expect(formatRecency('2026-10-29T12:01:00Z',now)).toBe('há 4 min.');
});

it('derives compact project and agent tags without losing unknown agents',()=>{
  expect(projectName('/home/user/dev/lazysh/')).toBe('lazysh');
  expect(projectName('C:\\work\\api')).toBe('api');
  expect(agentKind('Claude Code')).toBe('claude');
  expect(agentKind('codex')).toBe('codex');
  expect(agentKind('Mystery agent')).toBe('other');
  expect(agentKind(null)).toBe('other');
});
