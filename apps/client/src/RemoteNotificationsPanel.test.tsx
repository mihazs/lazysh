// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import RemoteNotificationsPanel from './RemoteNotificationsPanel';
import { t, uiI18n } from './i18n/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn() }));
afterEach(async () => { cleanup(); vi.clearAllMocks(); await uiI18n.changeLanguage('en'); });

const off = { supported: true, configured: false, enabled: false, running: false, origin: null, error: null };
const on = { ...off, configured: true, enabled: true, running: true, origin: 'https://gotify.example.com' };
const access = { headers: { 'X-Lazysh-Access': expect.any(String) } };
const commands = () => vi.mocked(invoke).mock.calls.map(([command]) => command);
async function enter(origin = 'https://gotify.example.com', token = 'client-token') {
  fireEvent.change(await screen.findByLabelText('Gotify server address (HTTPS)'), { target: { value: origin } });
  fireEvent.change(screen.getByLabelText('Gotify client token'), { target: { value: token } });
}

it('stays absent where the build has no desktop receiver and never contacts a server on mount', async () => {
  vi.mocked(invoke).mockResolvedValue({ ...off, supported: false });
  const { container } = render(<RemoteNotificationsPanel />);
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(container.textContent).toBe('');
  expect(commands()).toEqual(['remote_notifications_status']);
  expect(requestPermission).not.toHaveBeenCalled();
});

it('connects only on the explicit action, after the system permission, and drops the token from the form', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(false);
  vi.mocked(requestPermission).mockResolvedValue('granted');
  vi.mocked(invoke).mockResolvedValueOnce(off).mockResolvedValueOnce(on);
  render(<RemoteNotificationsPanel />);
  await enter();
  expect(requestPermission).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText('Receiving from https://gotify.example.com.')).toBeTruthy();
  expect(requestPermission).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenLastCalledWith('remote_notifications_configure', { kind: 'gotify', origin: 'https://gotify.example.com', topic: '', token: 'client-token' }, access);
  expect(document.body.innerHTML).not.toContain('client-token');
  expect(screen.queryByLabelText('Gotify client token')).toBeNull();
});

it('does not save a token when the operating system refuses notifications', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(false);
  vi.mocked(requestPermission).mockResolvedValue('denied');
  vi.mocked(invoke).mockResolvedValue(off);
  render(<RemoteNotificationsPanel />);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect((await screen.findByRole('alert')).textContent).toBe(t('remoteNotifErrorPermission'));
  expect(commands()).toEqual(['remote_notifications_status']);
});

it('pauses, resumes and removes the saved token, reflecting what the native side reports', async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(on)
    .mockResolvedValueOnce({ ...on, enabled: false, running: false })
    .mockResolvedValueOnce(on)
    .mockResolvedValueOnce(off);
  render(<RemoteNotificationsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByText('Paused. Nothing is read from https://gotify.example.com.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(await screen.findByText('Receiving from https://gotify.example.com.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove from this computer' }));
  expect(await screen.findByLabelText('Gotify client token')).toBeTruthy();
  expect(commands()).toEqual(['remote_notifications_status', 'remote_notifications_pause', 'remote_notifications_resume', 'remote_notifications_forget']);
});

it('shows a stopped receiver and a finite error code in the interface language, never raw server or OS text', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...on, running: false, error: 'unauthorized' }).mockRejectedValueOnce(new Error('PRIVATE gotify.example.com body'));
  render(<RemoteNotificationsPanel />);
  expect((await screen.findByRole('alert')).textContent).toBe(t('remoteNotifErrorUnauthorized'));
  expect(screen.getByRole('status').textContent).toContain('Not receiving from');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('remoteNotifErrorGeneric')));
  expect(document.body.textContent).not.toContain('PRIVATE');
  await act(async () => { await uiI18n.changeLanguage('pt-BR'); });
  expect(screen.getByRole('alert').textContent).toBe(t('remoteNotifErrorGeneric'));
  expect(screen.getByRole('button', { name: 'Pausar' })).toBeTruthy();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('shows the native rejection code for a wrong token', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockResolvedValueOnce(off).mockRejectedValueOnce('unauthorized');
  render(<RemoteNotificationsPanel />);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect((await screen.findByRole('alert')).textContent).toBe(t('remoteNotifErrorUnauthorized'));
  expect(screen.getByLabelText('Gotify client token')).toBeTruthy();
});

it('connects an ntfy topic with an optional token, asks for the topic and clears it from the form', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockResolvedValueOnce(off).mockResolvedValueOnce({ ...on, origin: 'https://ntfy.example.com' });
  render(<RemoteNotificationsPanel />);
  fireEvent.change(await screen.findByLabelText('Server'), { target: { value: 'ntfy' } });
  expect(screen.queryByLabelText('Gotify client token')).toBeNull();
  fireEvent.change(screen.getByLabelText('ntfy server address (HTTPS)'), { target: { value: 'https://ntfy.example.com' } });
  const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('ntfy topic'), { target: { value: 'alerts' } });
  expect(connect.disabled).toBe(false);
  fireEvent.click(connect);
  expect(await screen.findByText('Receiving from https://ntfy.example.com.')).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith('remote_notifications_configure', { kind: 'ntfy', origin: 'https://ntfy.example.com', topic: 'alerts', token: '' }, access);
  expect(document.body.innerHTML).not.toContain('alerts');
  expect(screen.queryByLabelText('ntfy topic')).toBeNull();
});

it('shows the native code for a bad topic in the interface language', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockResolvedValueOnce(off).mockRejectedValueOnce('topic');
  render(<RemoteNotificationsPanel />);
  fireEvent.change(await screen.findByLabelText('Server'), { target: { value: 'ntfy' } });
  fireEvent.change(screen.getByLabelText('ntfy server address (HTTPS)'), { target: { value: 'https://ntfy.example.com' } });
  fireEvent.change(screen.getByLabelText('ntfy topic'), { target: { value: 'a/b' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect((await screen.findByRole('alert')).textContent).toBe(t('remoteNotifErrorTopic'));
  await act(async () => { await uiI18n.changeLanguage('es'); });
  expect(screen.getByRole('alert').textContent).toBe('Introduce el nombre del tema: hasta 64 letras, dígitos, _ o -.');
});
