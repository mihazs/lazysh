import {expect,it,vi} from 'vitest';
import {expandHome,resolveHostPath} from './hostPath';
import {LocalUiError} from './i18n/localError';

const home = '/home/mía';
const fakeHost = (reply = home) => ({hostHome: vi.fn(async (_session: string) => reply)});

it.each([
  ['~', home],
  ['~/', home],
  ['~/dev/project', `${home}/dev/project`],
  ['~/my dir/ünï cödé 世界/', `${home}/my dir/ünï cödé 世界`],
  ['~//a', `${home}/a`],
  ['$HOME', home],
  ['$HOME/x y', `${home}/x y`],
  ['${HOME}/x', `${home}/x`],
])('expands %j against the host home', (typed, expected) => {
  expect(expandHome(typed, home)).toBe(expected);
});

it.each(['/abs/~/x', 'a/~/b', './~', '$HOMEWORK/x', '${HOME}x', '.', 'relative/path', 'C:\\Users\\me'])('leaves %j alone when it is not a home reference', typed => {
  expect(expandHome(typed, home)).toBe(typed);
});

it('refuses another user\'s home instead of guessing it', () => {
  for (const typed of ['~root', '~root/.ssh', '~mia/x']) expect(() => expandHome(typed, home)).toThrow(LocalUiError);
});

it('keeps a root, slash-terminated or Windows home usable as a base', () => {
  expect(expandHome('~/x', '/')).toBe('/x');
  expect(expandHome('~', '/')).toBe('/');
  expect(expandHome('~/x', '/srv/home/')).toBe('/srv/home/x');
  expect(expandHome('~/x', 'C:\\Users\\me')).toBe('C:\\Users\\me/x');
});

it('asks the host for its home once per session and only for home references', async () => {
  const api = fakeHost();
  expect(await resolveHostPath(api, 'session-1', '/etc/hosts')).toBe('/etc/hosts');
  expect(api.hostHome).not.toHaveBeenCalled();
  expect(await resolveHostPath(api, 'session-1', '~/a')).toBe(`${home}/a`);
  expect(await resolveHostPath(api, 'session-1', '$HOME/b')).toBe(`${home}/b`);
  expect(api.hostHome).toHaveBeenCalledTimes(1);
  expect(await resolveHostPath(api, 'session-2', '~')).toBe(home);
  expect(api.hostHome).toHaveBeenCalledTimes(2);
  expect(api.hostHome.mock.calls.map(call => call[0])).toEqual(['session-1', 'session-2']);
});

it('does not remember a failed home lookup', async () => {
  const api = fakeHost();
  api.hostHome.mockRejectedValueOnce(new Error('realpath unsupported'));
  await expect(resolveHostPath(api, 'session-3', '~/a')).rejects.toThrow('realpath unsupported');
  expect(await resolveHostPath(api, 'session-3', '~/a')).toBe(`${home}/a`);
  expect(api.hostHome).toHaveBeenCalledTimes(2);
});
