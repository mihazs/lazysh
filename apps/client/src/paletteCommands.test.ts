import {describe, expect, it} from 'vitest';
import {paletteCommands, type PaletteContext} from './paletteCommands';
import {navigationShortcutKeys} from './navigationShortcuts';

const noop = () => {};
const context = (choices = {}): PaletteContext => ({
  native: true, hosts: [], sessions: [{id: 's1', name: 'prod', destination: 'prod', connected: true}], activeId: 's1',
  tools: [{id: 'terminal', label: 'Terminal'}, {id: 'agents', label: 'Agents'}], navigationBusy: false, navigationKeys: navigationShortcutKeys(choices),
  local: {available: true, busy: false, reason: ''},
  run: {host: noop, local: noop, addHost: noop, session: noop, tool: noop, workspaces: noop, switcher: noop, closeActive: noop, preferences: noop, push: noop, inbox: noop, sync: noop, sharing: noop, about: noop},
});
const hints = (choices?: object) => Object.fromEntries(paletteCommands(context(choices)).filter(command => command.id === 'tool:agents' || command.id === 'action:workspaces').map(command => [command.id, command.shortcut?.keys]));

describe('palette chord hints', () => {
  it('show the default chords for Agents and Workspaces', () => {
    expect(hints()).toEqual({'tool:agents': 'Control+Shift+A', 'action:workspaces': 'Control+Shift+W'});
  });
  it('follow the saved keys and disappear while a chord is off', () => {
    expect(hints({navigationAgents: 'B', navigationWorkspaces: 'off'})).toEqual({'tool:agents': 'Control+Shift+B', 'action:workspaces': undefined});
  });
});
