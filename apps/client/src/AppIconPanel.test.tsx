// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import AppIconPanel from './AppIconPanel';
import { applyAccessStatus } from './access';
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(), isTauri: () => true}));
const status = (current = 'default', available = true) => ({available, current, reason: 'Actual UIKit readback'});
let generation = 0;
const unlocked = () => ({initialized: true, supported: true, enabled: false, locked: false, reason: '', generation: String(generation), nonce: 'a'.repeat(64)});
beforeEach(() => { generation += 10; applyAccessStatus(unlocked()); vi.mocked(invoke).mockReset(); });
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
  expect(screen.getByRole('status').childNodes).toHaveLength(1);
  expect(invoke).toHaveBeenLastCalledWith('set_app_icon', {icon:'amber'}, {headers: {'X-Lazysh-Access': 'a'.repeat(64)}});
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

it.each(['success', 'failure'])('drops a stale native %s on the same mounted view across lock and unlock', async outcome => {
  let finish!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  vi.mocked(invoke).mockResolvedValueOnce(status()).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const old = render(<AppIconPanel />);
  await screen.findByText('Current icon: Default');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'amber'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await act(async () => { generation++; applyAccessStatus({...unlocked(), locked: true, nonce: undefined}); });
  await act(async () => { generation++; applyAccessStatus(unlocked()); });
  // Keep the old mount: unmount cleanup must not be what rejects stale callbacks.
  const requests = vi.mocked(invoke).mock.calls.length;
  await act(async () => { if (outcome === 'success') finish(status('amber')); else fail('Old native icon failure'); });
  expect(screen.getByText('Current icon: Default')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(requests);
  old.unmount();
  vi.mocked(invoke).mockResolvedValue(status('amber'));
  render(<AppIconPanel />);
  await screen.findByText('Current icon: Amber');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'default'}});
  vi.mocked(invoke).mockResolvedValue(status());
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await screen.findByText('Current icon: Default');
  expect(screen.queryByRole('alert')).toBeNull();
});
