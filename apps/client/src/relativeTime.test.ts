import {afterEach,expect,it} from 'vitest';
import {formatRelativeTime,pathBasename} from './relativeTime';
import {uiI18n} from './i18n/core';

afterEach(async()=>{await uiI18n.changeLanguage('en');});

it('describes report recency in the active interface language',async()=>{
  const now=Date.parse('2026-10-29T12:05:00Z');
  await uiI18n.changeLanguage('en');
  expect(formatRelativeTime('2026-10-29T12:05:00Z',now)).toBe('now');
  expect(formatRelativeTime('2026-10-29T12:01:00Z',now)).toBe('4 min. ago');
  expect(formatRelativeTime('2026-10-29T09:05:00Z',now)).toBe('3 hr. ago');
  expect(formatRelativeTime('2026-10-27T12:05:00Z',now)).toBe('2 days ago');
  await uiI18n.changeLanguage('pt-BR');
  expect(formatRelativeTime('2026-10-29T12:01:00Z',now)).toBe('há 4 min.');
});

it('derives a compact project tag from POSIX and Windows paths',()=>{
  expect(pathBasename('/home/user/dev/lazysh/')).toBe('lazysh');
  expect(pathBasename('C:\\work\\api')).toBe('api');
});
