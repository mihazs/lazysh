// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TerminalEngineNotice from './TerminalEngineNotice';
import {defaults, getPreferences, savePreferences} from './preferences';
import type {TerminalBackendId} from './terminalAdapter';

const notice = 'The terminal engine changed on this platform. Switch back in Settings, Terminal engine.';
const openSettings = vi.fn();

/** One app launch on a device whose Auto resolves to `engine`. */
async function launch(engine: TerminalBackendId) {
  cleanup();
  const resolve = vi.fn(async () => engine);
  render(<TerminalEngineNotice onOpenSettings={openSettings} resolve={resolve}/>);
  await act(async () => { await resolve.mock.results[0]?.value; });
}

beforeEach(() => { localStorage.clear(); savePreferences(defaults); openSettings.mockClear(); });
afterEach(cleanup);

it('says nothing on a fresh install, nor while the default stays the same', async () => {
  await launch('native');
  expect(screen.queryByRole('status')).toBeNull();
  await launch('native');
  expect(screen.queryByRole('status')).toBeNull();
});

it('announces a changed default on every launch until it is dismissed, then never again', async () => {
  await launch('xterm');
  await launch('native');
  expect(screen.getByRole('status').textContent).toContain(notice);
  await launch('native');
  await userEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
  expect(screen.queryByRole('status')).toBeNull();
  await launch('native');
  expect(screen.queryByRole('status')).toBeNull();
  expect(openSettings).not.toHaveBeenCalled();
});

it('opens Settings from the notice and does not show it again', async () => {
  await launch('xterm');
  await launch('native');
  await userEvent.click(screen.getByRole('button', {name: 'Open Settings'}));
  expect(openSettings).toHaveBeenCalledOnce();
  await launch('native');
  expect(screen.queryByRole('status')).toBeNull();
});

it('never tells a user who chose an engine, even after the choice returns to Auto', async () => {
  await launch('xterm');
  savePreferences({...getPreferences(), terminalEngine: 'xterm'});
  await launch('native');
  expect(screen.queryByRole('status')).toBeNull();
  savePreferences(defaults);
  await launch('native');
  expect(screen.queryByRole('status')).toBeNull();
});
