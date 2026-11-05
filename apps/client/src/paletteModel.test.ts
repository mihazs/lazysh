import {expect, it, vi} from 'vitest';
import {filterPalette, firstEnabled, movePaletteSelection, type PaletteCommand} from './paletteModel';

const command = (id: string, label: string, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({id, group: 'action', label, run: vi.fn(), ...extra});
const commands = [
  command('host', 'Build server', {group: 'host', detail: 'deploy@ci.example'}),
  command('files', 'Files', {group: 'tool', keywords: ['browse']}),
  command('diff', 'Diff', {group: 'tool', keywords: ['git']}),
  command('prefs', 'Preferences', {keywords: ['settings']}),
  command('session', 'Sessão principal', {group: 'session', detail: 'dev@home'}),
];
const ids = (query: string) => filterPalette(commands, query).map(item => item.id);

it('keeps the given order for an empty query and drops commands that do not match every token', () => {
  expect(ids('')).toEqual(['host', 'files', 'diff', 'prefs', 'session']);
  expect(ids('   ')).toEqual(['host', 'files', 'diff', 'prefs', 'session']);
  expect(ids('zzz')).toEqual([]);
  expect(ids('build zzz')).toEqual([]);
});

it('matches ordered subsequences, details, aliases and accents, ranking label prefixes first', () => {
  expect(ids('fls')).toEqual(['files']);
  expect(ids('ci.example')).toEqual(['host']);
  // Details and keywords need contiguous text, so scattered letters do not match them.
  expect(ids('dpx')).toEqual([]);
  expect(ids('git')).toEqual(['diff']);
  expect(ids('settings')).toEqual(['prefs']);
  expect(ids('sessao')).toEqual(['session']);
  expect(ids('SESSÃO dev')).toEqual(['session']);
  // "pr" starts "Preferences" but is only a scattered subsequence elsewhere.
  expect(ids('pr')[0]).toBe('prefs');
  expect(ids('d')[0]).toBe('diff');
});

it('moves with arrow keys, wraps, skips disabled commands and ignores other keys', () => {
  const list = [command('a', 'A', {disabled: true}), command('b', 'B'), command('c', 'C', {disabled: true}), command('d', 'D')];
  expect(firstEnabled(list)).toBe(1);
  expect(movePaletteSelection(list, 1, 'ArrowDown')).toBe(3);
  expect(movePaletteSelection(list, 3, 'ArrowDown')).toBe(1);
  expect(movePaletteSelection(list, 1, 'ArrowUp')).toBe(3);
  expect(movePaletteSelection(list, -1, 'ArrowDown')).toBe(1);
  expect(movePaletteSelection(list, -1, 'ArrowUp')).toBe(3);
  expect(movePaletteSelection(list, 1, 'Enter')).toBe(1);
  const blocked = [command('x', 'X', {disabled: true})];
  expect(firstEnabled(blocked)).toBe(-1);
  expect(movePaletteSelection(blocked, -1, 'ArrowDown')).toBe(-1);
  expect(movePaletteSelection([], -1, 'ArrowDown')).toBe(-1);
});
