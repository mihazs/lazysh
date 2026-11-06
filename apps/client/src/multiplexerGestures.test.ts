// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {multiplexerSteps, resolveGesture, storedPrefix, validPrefix} from './multiplexerGestures';
import {gestureSlots} from './preferences';

afterEach(() => localStorage.clear());

it('sends each tmux and Herdr action as its prefix followed by the default binding', () => {
  expect(['nextTab', 'previousTab', 'nextPane', 'previousPane', 'zoomPane'].map(action => multiplexerSteps('tmux', action as never))).toEqual([
    ['\x02', 'n'], ['\x02', 'p'], ['\x02', 'o'], ['\x02', ':', 'select-pane -t :.-', '\r'], ['\x02', 'z'],
  ]);
  expect(['nextTab', 'previousTab', 'nextPane', 'previousPane', 'zoomPane'].map(action => multiplexerSteps('herdr', action as never, 'F12'))).toEqual([
    ['\x1b[24~', 'n'], ['\x1b[24~', 'p'], ['\x1b[24~', 'l'], ['\x1b[24~', 'h'], ['\x1b[24~', 'z'],
  ]);
});

it('uses the prefix saved by the shortcut panel for its own multiplexer only', () => {
  localStorage.setItem('lazysh.multiplexer.prefix.herdr', 'Ctrl+a');
  expect(storedPrefix('herdr')).toBe('Ctrl+a');
  expect(storedPrefix('tmux')).toBe('Ctrl+b');
  expect(multiplexerSteps('herdr', 'zoomPane')).toEqual(['\x01', 'z']);
  for (const prefix of ['Ctrl+b n', 'Ctrl+b,n', 'text:a', 'Contrl-b', '']) expect(validPrefix(prefix)).toBe(false);
  expect(validPrefix('F12')).toBe(true);
});

it('resolves level-aware defaults by multiplexer presence and leaves explicit choices alone', () => {
  const resolved = (kind?: 'tmux' | 'herdr' | 'zellij') => Object.fromEntries(gestureSlots.map(slot => [slot, resolveGesture('auto', slot, kind)]).filter(([, action]) => action !== 'none'));
  const multiplexer = {twoLeft: 'nextTab', twoRight: 'previousTab', twoUp: 'nextPane', twoDown: 'previousPane', pinch: 'zoomPane', pullShallow: 'nextTab', pullDeep: 'nextSession'};
  for (const kind of ['tmux', 'herdr', 'zellij'] as const) expect(resolved(kind)).toEqual(multiplexer);
  expect(resolved()).toEqual({twoLeft: 'nextSession', twoRight: 'previousSession', twoUp: 'openAgents', twoDown: 'openWorkspaces', pinch: 'fontSize', pullDeep: 'nextSession'});
  expect(resolveGesture('auto', undefined, 'tmux')).toBe('none');
  expect(resolveGesture('find', 'pullShallow', 'tmux')).toBe('find');
  expect(resolveGesture('none', 'twoLeft', undefined)).toBe('none');
  // A local terminal has no Agents: the default and an explicit binding both stay inert; Workspaces still opens.
  expect(resolveGesture('auto', 'twoUp', undefined, true)).toBe('none');
  expect(resolveGesture('openAgents', 'pullDeep', undefined, true)).toBe('none');
  expect(resolveGesture('auto', 'twoDown', undefined, true)).toBe('openWorkspaces');
});
