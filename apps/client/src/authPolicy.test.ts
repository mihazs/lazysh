// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {authChoice, authPolicyKey, defaultAuthChoice, ownAuthChoice, parseAuthPolicy, setDefaultAuthChoice, setHostAuthChoice} from './authPolicy';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('asks everywhere until someone chooses, then a host\'s own choice beats the default', () => {
  expect(authChoice('box', 'tunnel')).toBe('ask');
  setDefaultAuthChoice('tunnel', 'never');
  expect(authChoice('box', 'tunnel')).toBe('never');
  setHostAuthChoice('box', 'tunnel', 'always');
  expect([authChoice('box', 'tunnel'), authChoice('other', 'tunnel'), defaultAuthChoice('tunnel'), ownAuthChoice('other', 'tunnel')]).toEqual(['always', 'never', 'never', undefined]);
  setHostAuthChoice('box', 'tunnel', undefined);
  expect(authChoice('box', 'tunnel')).toBe('never');
  expect(JSON.parse(localStorage.getItem(authPolicyKey)!)).toEqual({defaults: {tunnel: 'never'}, hosts: {}});
});

it('reads a damaged, foreign or hand-edited value as Ask and keeps only the exact shape', () => {
  for (const raw of ['{', 'null', '7', '"always"', '{"defaults":{"tunnel":"sometimes"},"hosts":{"box":{"tunnel":"yes"}}}']) {
    localStorage.setItem(authPolicyKey, raw);
    expect([authChoice('box', 'tunnel'), defaultAuthChoice('tunnel')]).toEqual(['ask', 'ask']);
  }
  expect(parseAuthPolicy({defaults: {tunnel: 'always', other: 'never'}, hosts: {box: {tunnel: 'never', url: 'https://x/?code=1'}, '': {tunnel: 'never'}}, extra: 1})).toEqual({defaults: {tunnel: 'always'}, hosts: {box: {tunnel: 'never'}}});
});

it('keeps a bounded number of hosts', () => {
  const hosts = Object.fromEntries(Array.from({length: 500}, (_, index) => [`host-${index}`, {tunnel: 'never'}]));
  expect(Object.keys(parseAuthPolicy({defaults: {}, hosts}).hosts)).toHaveLength(200);
});

it('stores host ids and choices only, never an address or a port', () => {
  setHostAuthChoice('box', 'tunnel', 'always');
  expect(localStorage.getItem(authPolicyKey)).toBe('{"defaults":{},"hosts":{"box":{"tunnel":"always"}}}');
});

it('answers Ask when storage returns nothing usable or refuses to be read (a test double once returned undefined and crashed the read)', () => {
  const read = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(undefined as unknown as string);
  expect(authChoice('box', 'tunnel')).toBe('ask');
  read.mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  expect(authChoice('box', 'tunnel')).toBe('ask');
});

// Last: a refused write keeps the choice in memory for the rest of the file.
it('holds a choice for the run when storage refuses it, instead of silently losing it', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  setHostAuthChoice('box', 'tunnel', 'never');
  expect(authChoice('box', 'tunnel')).toBe('never');
});
