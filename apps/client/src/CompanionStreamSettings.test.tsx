// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import CompanionStreamSettings from './CompanionStreamSettings';
vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn()}));
afterEach(() => {cleanup(); vi.clearAllMocks();});
it('saves a revision-bound stream policy and keeps old companions unavailable', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({schemaVersion:1, revision:4, enabled:true}).mockResolvedValueOnce({schemaVersion:1, revision:5, enabled:false});
  const view = render(<CompanionStreamSettings sessionId="host" visible/>);
  fireEvent.click(await screen.findByLabelText('Device preview streaming'));
  await waitFor(() => expect(screen.getByLabelText('Device preview streaming')).toHaveProperty('checked', false));
  expect(vi.mocked(invoke).mock.lastCall?.[1]).toEqual({sessionId:'host', expectedRevision:4, enabled:false});
  view.unmount();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('unknown command'));
  render(<CompanionStreamSettings sessionId="older" visible/>);
  await screen.findByText(/Streaming settings are unavailable/);
  expect(screen.queryByLabelText('Device preview streaming')).toBeNull();
});
it('retires a pending update when the panel is hidden', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockResolvedValueOnce({schemaVersion:1, revision:0, enabled:true}).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})).mockResolvedValueOnce({schemaVersion:1, revision:1, enabled:false});
  const view = render(<CompanionStreamSettings sessionId="host" visible/>);
  fireEvent.click(await screen.findByLabelText('Device preview streaming'));
  view.rerender(<CompanionStreamSettings sessionId="host" visible={false}/>);
  await act(async () => finish({schemaVersion:1, revision:1, enabled:false}));
  view.rerender(<CompanionStreamSettings sessionId="host" visible/>);
  await waitFor(() => expect(screen.getByLabelText('Device preview streaming')).toHaveProperty('checked', false));
});
