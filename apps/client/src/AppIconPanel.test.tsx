// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import AppIconPanel from './AppIconPanel';
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(), isTauri: () => true}));
const status = (current = 'default', available = true) => ({available, current, reason: 'Actual UIKit readback'});
beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(cleanup);
it('does not offer changes on unsupported platforms', async () => {
  vi.mocked(invoke).mockResolvedValue(status('default', false)); render(<AppIconPanel />);
  await screen.findByText('Actual UIKit readback');
  expect(screen.getByRole<HTMLButtonElement>('button', {name: 'Apply app icon'}).disabled).toBe(true);
});
it('waits for native completion before reporting the actual icon', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockResolvedValueOnce(status()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<AppIconPanel />); await screen.findByText('Actual UIKit readback');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'amber'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  expect(screen.getByText('Current icon: Default')).toBeTruthy();
  finish(status('amber')); await screen.findByText('Current icon: Amber');
  expect(invoke).toHaveBeenLastCalledWith('set_app_icon', {icon:'amber'});
});
it('refreshes actual state after failure and can restore the primary icon', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(status('amber')).mockRejectedValueOnce('iOS rejected the change').mockResolvedValueOnce(status('amber')).mockResolvedValueOnce(status());
  render(<AppIconPanel />); await screen.findByText('Current icon: Amber');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'default'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await screen.findByText('iOS rejected the change');
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  expect(screen.getByText('Current icon: Amber')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'default'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await screen.findByText('Current icon: Default');
});
it('fails closed on malformed status', async () => {
  vi.mocked(invoke).mockResolvedValue({available:true,current:'fake'}); render(<AppIconPanel />);
  await screen.findByRole('alert');
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'Apply app icon'}).disabled).toBe(true);
});
