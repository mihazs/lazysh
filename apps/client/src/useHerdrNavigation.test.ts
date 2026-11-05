import {expect,it} from 'vitest';
import {homeRelativePath} from './useHerdrNavigation';

it('shortens the login user home to ~ and names other homes without guessing',()=>{
  const destination='mihael@desktop.invalid · Mosh';
  expect(homeRelativePath('/home/mihael/dev/lazysh',destination)).toBe('~/dev/lazysh');
  expect(homeRelativePath('/home/mihael',destination)).toBe('~');
  expect(homeRelativePath('/Users/mihael/src',destination)).toBe('~/src');
  expect(homeRelativePath('/home/alice/dev',destination)).toBe('~alice/dev');
  expect(homeRelativePath('/home/mihaela/dev',destination)).toBe('~mihaela/dev');
  expect(homeRelativePath('/root/work','root@server')).toBe('~/work');
  expect(homeRelativePath('/root/work','builder')).toBe('~root/work');
  expect(homeRelativePath('/srv/home/mihael',destination)).toBe('/srv/home/mihael');
  expect(homeRelativePath('/home',destination)).toBe('/home');
});
