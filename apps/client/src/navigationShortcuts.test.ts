import {describe, expect, it} from 'vitest';
import {navigationKeyAvailable, navigationShortcutKeys, parseNavigationShortcuts} from './navigationShortcuts';

describe('Agents and Workspaces keyboard chords', () => {
  it('use Ctrl/Cmd+Shift+A and W until a key is chosen or the chord is turned off', () => {
    expect(navigationShortcutKeys()).toEqual({agents: 'A', workspaces: 'W'});
    expect(navigationShortcutKeys({navigationAgents: 'B'})).toEqual({agents: 'B', workspaces: 'W'});
    expect(navigationShortcutKeys({navigationWorkspaces: 'off'})).toEqual({agents: 'A', workspaces: undefined});
  });
  it('keep a letter or off, upper-cased, and drop everything else and the defaults', () => {
    expect(parseNavigationShortcuts({navigationAgents: 'b', navigationWorkspaces: 'off'})).toEqual({navigationAgents: 'B', navigationWorkspaces: 'off'});
    expect(parseNavigationShortcuts({navigationAgents: 'A', navigationWorkspaces: 'w'})).toEqual({});
    for (const value of ['', 'AB', '1', '!', ' ', 'Off', 7, null, true, {}]) expect(parseNavigationShortcuts({navigationAgents: value, navigationWorkspaces: value})).toEqual({});
  });
  it('refuse the keys the palette, find and the Agent view already use', () => {
    for (const key of ['P', 'p', 'F', 'Y']) expect(parseNavigationShortcuts({navigationAgents: key})).toEqual({});
    expect(['P', 'F', 'Y', 'K', 'O'].map(key => navigationKeyAvailable(key, 'agents', navigationShortcutKeys()))).toEqual([false, false, false, true, true]);
  });
  it('never share a key: both return to their defaults', () => {
    expect(parseNavigationShortcuts({navigationAgents: 'B', navigationWorkspaces: 'B'})).toEqual({});
    // Agents on the key Workspaces still has by default.
    expect(parseNavigationShortcuts({navigationAgents: 'W'})).toEqual({});
    expect(navigationKeyAvailable('W', 'agents', navigationShortcutKeys())).toBe(false);
    expect(navigationKeyAvailable('A', 'workspaces', navigationShortcutKeys())).toBe(false);
    // Swapping is not a clash, and a chord that is off frees its key.
    expect(parseNavigationShortcuts({navigationAgents: 'W', navigationWorkspaces: 'A'})).toEqual({navigationAgents: 'W', navigationWorkspaces: 'A'});
    expect(parseNavigationShortcuts({navigationAgents: 'off', navigationWorkspaces: 'B'})).toEqual({navigationAgents: 'off', navigationWorkspaces: 'B'});
    expect(navigationKeyAvailable('W', 'agents', navigationShortcutKeys({navigationWorkspaces: 'off'}))).toBe(true);
  });
});
