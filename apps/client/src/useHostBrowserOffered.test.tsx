// @vitest-environment jsdom
import {act, cleanup, renderHook, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {announceHostBrowserSwitch, confirmHostBrowser} from './hostBrowserConfirmation';
import {useHostBrowserOffered} from './useHostBrowserOffered';
import {answer, calls} from './test/routedInvoke';
vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn()}));

const setting = (hostBrowserEnabled: unknown) => ({schemaVersion: 1, revision: 1, hostBrowserEnabled});
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('offers nothing, and asks the host nothing, until this device confirmed the host', async () => {
  answer({get_host_browser_settings: [setting(true)]});
  const {result} = renderHook(() => useHostBrowserOffered('s1', 'host-a'));
  await act(async () => {});
  expect(result.current).toBe(false);
  expect(calls('get_host_browser_settings')).toHaveLength(0);
  expect(vi.mocked(invoke)).not.toHaveBeenCalled();
});

it.each([[true, true], [false, false], ['yes', false]])('offers a confirmed host whose switch reads %s: %s', async (enabled, offered) => {
  confirmHostBrowser('host-a');
  answer({get_host_browser_settings: [setting(enabled)]});
  const {result} = renderHook(() => useHostBrowserOffered('s1', 'host-a'));
  await waitFor(() => expect(calls('get_host_browser_settings')).toHaveLength(1));
  await act(async () => {});
  expect(result.current).toBe(offered);
  expect(calls('get_host_browser_settings')[0][1]).toEqual({sessionId: 's1'});
});

it('reads the switch again when it is saved, and keeps its answer when a read fails', async () => {
  confirmHostBrowser('host-a');
  answer({get_host_browser_settings: [setting(true), setting(false), setting(true), () => Promise.reject(new Error('offline'))]});
  const {result} = renderHook(() => useHostBrowserOffered('s1', 'host-a'));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => announceHostBrowserSwitch());
  await waitFor(() => expect(result.current).toBe(false));
  act(() => announceHostBrowserSwitch());
  await waitFor(() => expect(result.current).toBe(true));
  act(() => announceHostBrowserSwitch());
  await waitFor(() => expect(calls('get_host_browser_settings')).toHaveLength(4));
  await act(async () => {});
  expect(result.current).toBe(true);
});

it('never carries one session\'s answer to another or offers without a session', async () => {
  confirmHostBrowser('host-a');
  answer({get_host_browser_settings: [setting(true), () => new Promise(() => {})]});
  const {result, rerender} = renderHook(({session}: {session?: string}) => useHostBrowserOffered(session, 'host-a'), {initialProps: {session: 's1' as string | undefined}});
  await waitFor(() => expect(result.current).toBe(true));
  rerender({session: 's2'});
  expect(result.current).toBe(false);
  rerender({session: undefined});
  expect(result.current).toBe(false);
});
