// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import PushSettingsPanel from './PushSettingsPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const off = { supported: true, configured: true, enabled: false, tokenPresent: false, busy: false, reason: 'Registration off' };

it('requires explicit external-service consent and never registers during mount', async () => {
  vi.mocked(invoke).mockResolvedValue(off);
  render(<PushSettingsPanel />);
  const button = await screen.findByRole('button', { name: 'Register this device' });
  expect(button).toHaveProperty('disabled', true);
  expect(vi.mocked(invoke).mock.calls).toEqual([['push_registration_status']]);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('push_registration_register'));
});

it('offers revocation retry after a native deletion failure without claiming success', async () => {
  const on = { ...off, enabled: true, tokenPresent: true };
  vi.mocked(invoke).mockResolvedValueOnce(on).mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_ERROR')).mockResolvedValue({ ...off, tokenPresent: true });
  const before = localStorage.length;
  render(<PushSettingsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause and revoke token' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('could not finish'));
  await screen.findByRole('button', { name: 'Retry token revocation' });
  expect(document.body.textContent).not.toContain('PRIVATE_PROVIDER_ERROR');
  expect(localStorage.length).toBe(before);
});

it('does not offer registration on an unconfigured build', async () => {
  vi.mocked(invoke).mockResolvedValue({ ...off, configured: false, reason: 'No Firebase configuration' });
  render(<PushSettingsPanel />);
  await screen.findByText('No Firebase configuration');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Register this device' })).toBeNull();
});

it('can pause pending registration and ignores its late completion', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockResolvedValueOnce(off)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(off);
  render(<PushSettingsPanel />);
  const register = await screen.findByRole('button', { name: 'Register this device' });
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(register);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause and revoke token' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('push_registration_disable'));
  await screen.findByText('Registration off');
  finish({ ...off, enabled: true, reason: 'Stale registration result' });
  await waitFor(() => expect(screen.queryByText('Stale registration result')).toBeNull());
});
