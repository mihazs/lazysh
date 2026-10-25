// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import CredentialsPanel from './CredentialsPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const info = { publicKey: 'ssh-ed25519 PUBLIC', fingerprint: 'SHA256:public', algorithm: 'ssh-ed25519' };

it('requires a generation passphrase and exposes only the public identity before explicit use', async () => {
  const onUse = vi.fn();
  vi.mocked(invoke).mockResolvedValue({ privateKey: 'PRIVATE_SECRET', info });
  const before = localStorage.length;
  const { container } = render(<CredentialsPanel onUse={onUse} />);
  expect(screen.getByRole('button', { name: 'Generate encrypted identity' })).toHaveProperty('disabled', true);
  fireEvent.change(screen.getByLabelText('Key passphrase'), { target: { value: 'correct passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate encrypted identity' }));
  await screen.findByDisplayValue(info.publicKey);
  expect(container.textContent).not.toContain('PRIVATE_SECRET');
  expect(localStorage.length).toBe(before);
  expect(onUse).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use for connection' }));
  expect(onUse).toHaveBeenCalledWith({ privateKey: 'PRIVATE_SECRET', passphrase: 'correct passphrase' });
  expect(screen.getByLabelText('Key passphrase')).toHaveProperty('value', '');
});

it('invalidates inspected identity when private input changes', async () => {
  vi.mocked(invoke).mockResolvedValue(info);
  render(<CredentialsPanel onUse={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Identity source'), { target: { value: 'import' } });
  fireEvent.change(screen.getByLabelText('Private key'), { target: { value: 'first-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect identity' }));
  await screen.findByDisplayValue(info.publicKey);
  fireEvent.change(screen.getByLabelText('Private key'), { target: { value: 'different-key' } });
  expect(screen.queryByRole('button', { name: 'Use for connection' })).toBeNull();
});
