// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {useState} from 'react';
import CommandPalette from './CommandPalette';
import type {PaletteCommand} from './paletteModel';

afterEach(cleanup);
function Harness({commands, onDone}: {commands: PaletteCommand[]; onDone: () => void}) {
  const [query, setQuery] = useState('');
  return <CommandPalette commands={commands} query={query} onQuery={setQuery} onDone={onDone}/>;
}
function setup() {
  const order: string[] = [];
  const make = (id: string, label: string, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({id, group: 'tool', label, run: vi.fn(() => order.push(id)), ...extra});
  const commands = [make('home', 'Home', {group: 'host', detail: 'dev@home.local'}), make('files', 'Files'), make('diff', 'Diff', {disabled: true}), make('prefs', 'Preferences', {group: 'action'})];
  const onDone = vi.fn(() => order.push('done'));
  render(<Harness commands={commands} onDone={onDone}/>);
  return {commands, onDone, order, input: screen.getByRole('combobox', {name: 'Search hosts, sessions and commands'})};
}
const activeOption = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-activedescendant') ?? '');

it('exposes a combobox that owns a listbox and points at the first runnable option', () => {
  const {input} = setup();
  const list = screen.getByRole('listbox', {name: 'Commands'});
  expect(input.getAttribute('aria-controls')).toBe(list.id);
  expect(input.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Homedev@home.localHost', 'FilesTool', 'DiffTool', 'PreferencesAction']);
  expect(activeOption(input)?.textContent).toContain('Home');
  expect(activeOption(input)?.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('option', {name: /Diff/}).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('status').textContent).toBe('4 results');
});

it('filters as the query changes, moves with arrows past disabled options and runs on Enter after closing', async () => {
  const user = userEvent.setup();
  const {input, commands, order} = setup();
  await user.click(input);
  await user.keyboard('{ArrowDown}');
  expect(activeOption(input)?.textContent).toContain('Files');
  await user.keyboard('{ArrowDown}');
  expect(activeOption(input)?.textContent).toContain('Preferences');
  await user.keyboard('{ArrowDown}');
  expect(activeOption(input)?.textContent).toContain('Home');
  await user.keyboard('fil');
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['FilesTool']);
  expect(screen.getByRole('status').textContent).toBe('1 result');
  await user.keyboard('{Enter}');
  expect(order).toEqual(['done', 'files']);
  expect(commands[0].run).not.toHaveBeenCalled();
});

it('never runs disabled options and reports an empty result', async () => {
  const user = userEvent.setup();
  const {input, commands, onDone} = setup();
  await user.click(screen.getByRole('option', {name: /Diff/}));
  expect(commands[2].run).not.toHaveBeenCalled();
  await user.type(input, 'diff');
  expect(input.getAttribute('aria-activedescendant')).toBeNull();
  await user.keyboard('{Enter}');
  expect(onDone).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, 'nothing-here');
  expect(screen.queryAllByRole('option')).toEqual([]);
  expect(screen.getByText('No matching hosts or commands.')).toBeTruthy();
});

it('runs a pointer-chosen option', async () => {
  const user = userEvent.setup();
  const {commands, onDone} = setup();
  await user.click(screen.getByRole('option', {name: /Preferences/}));
  expect(onDone).toHaveBeenCalledOnce();
  expect(commands[3].run).toHaveBeenCalledOnce();
});
