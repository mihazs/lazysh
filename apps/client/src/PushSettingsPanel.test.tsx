// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import PushSettingsPanel from './PushSettingsPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
import {pushStatus as off} from './test/pushData';

it.each(['fcm','unifiedpush'])('requires explicit %s consent and never registers during mount', async provider => {
  vi.mocked(invoke).mockResolvedValue({...off,provider});
  render(<PushSettingsPanel />);
  const button = await screen.findByRole('button', { name: 'Register this device' });
  expect(button).toHaveProperty('disabled', true);
  expect(vi.mocked(invoke).mock.calls).toEqual([['push_registration_status', undefined, {headers:{'X-Lazysh-Access':expect.any(String)}}]]);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('push_registration_register', undefined, { headers: { "X-Lazysh-Access": expect.any(String) } }));
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
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('push_registration_disable', undefined, { headers: { "X-Lazysh-Access": expect.any(String) } }));
  await screen.findByText('Registration off');
  finish({ ...off, enabled: true, reason: 'Stale registration result' });
  await waitFor(() => expect(screen.queryByText('Stale registration result')).toBeNull());
});

it('discloses Apple contact and local-only disable semantics for APNs', async () => {
  vi.mocked(invoke).mockResolvedValue({ ...off, provider: 'apns', enabled: true, tokenPresent: true });
  render(<PushSettingsPanel />);
  await screen.findByRole('button', { name: 'Disable APNs registration' });
  expect(document.body.textContent).toContain('Apple APNs');
  expect(document.body.textContent).not.toContain('Google Firebase');
  expect(document.body.textContent).toContain('does not invalidate a token globally');
});

it('names UnifiedPush without Google and discloses registration-only cleanup', async () => {
  vi.mocked(invoke).mockResolvedValue({ ...off, provider: 'unifiedpush', enabled: true, tokenPresent: true });
  render(<PushSettingsPanel />);
  await screen.findByRole('button', { name: 'Pause and remove registration' });
  expect(document.body.textContent).toContain('UnifiedPush');
  expect(document.body.textContent).not.toContain('Google Firebase');
  expect(document.body.textContent).toContain('does not connect remote delivery');
  expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
});

it('opens private enrollment only after consent with no credential arguments or renderer storage',async()=>{
  vi.mocked(invoke).mockResolvedValue({...off,provider:'unifiedpush'});
  const before=localStorage.length;
  render(<PushSettingsPanel/>);
  const connect=await screen.findByRole('button',{name:'Connect or resume delivery service'});
  expect(connect).toHaveProperty('disabled',true);
  expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(connect);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('push_registration_enroll',undefined,{headers:{'X-Lazysh-Access':expect.any(String)}}));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(localStorage.length).toBe(before);
});

it('can pause pending native enrollment and discards its late success',async()=>{
  const unified={...off,provider:'unifiedpush'};
  let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(unified)
    .mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(unified);
  render(<PushSettingsPanel/>);
  const connect=await screen.findByRole('button',{name:'Connect or resume delivery service'});
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(connect);
  fireEvent.click(await screen.findByRole('button',{name:'Pause and remove registration'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('push_registration_disable',undefined,{headers:{'X-Lazysh-Access':expect.any(String)}}));
  finish({...unified,enabled:true,reason:'Stale private confirmation'});
  await waitFor(()=>expect(screen.queryByText('Stale private confirmation')).toBeNull());
});
