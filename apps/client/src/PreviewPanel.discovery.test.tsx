// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import PreviewPanel from './PreviewPanel';
import {accessSnapshot, acknowledgeAccessReady, applyAccessStatus} from './access';
import {previewFixture} from './test/previewData';
let accessGeneration = 100;
function authority(locked = false) {
  applyAccessStatus({initialized: true, supported: true, reason: '', enabled: true, locked, generation: String(++accessGeneration), ...(locked ? {} : {nonce: 'e'.repeat(64)})});
  acknowledgeAccessReady(accessSnapshot().epoch);
}
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(), isTauri: () => false}));
const row = {port: 3000, address: '127.0.0.1', process: 'node', pid: null, http: null};
const calls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'discover_preview_ports');
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
async function mount() {
  const view = render(<PreviewPanel sessionId="periodic-one" />);
  await act(async () => {});
  return view;
}
function automatic() { fireEvent.click(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})); }
beforeEach(() => {
  vi.useFakeTimers(); authority();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.mocked(invoke).mockImplementation(async command => command === 'discover_preview_ports' ? [row] : []);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); localStorage.clear(); });
it('starts only after explicit opt-in and five seconds, updates listeners without forwarding', async () => {
  await mount();
  await advance(15000);
  expect(calls()).toHaveLength(0);
  automatic();
  await advance(4999); expect(calls()).toHaveLength(0);
  await advance(1); expect(calls()).toHaveLength(1);
  expect(screen.getByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeTruthy();
  expect(calls()[0][1]).toEqual({sessionId: 'periodic-one', allowPorts: null, probeHttp: false});
  vi.mocked(invoke).mockResolvedValue([]);
  await advance(5000);
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'start_preview')).toBe(false);
});
it('waits for settlement, drops hidden results, and restarts the cadence when visible', async () => {
  let resolve!: (rows: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'discover_preview_ports' ? new Promise(done => {resolve = done;}) : Promise.resolve([]));
  await mount(); automatic(); await advance(5000);
  await advance(30000); expect(calls()).toHaveLength(1);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await act(async () => { resolve([row]); });
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
  await advance(10000); expect(calls()).toHaveLength(1);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  await advance(4999); expect(calls()).toHaveLength(1);
  await advance(1); expect(calls()).toHaveLength(2);
  await act(async () => { resolve([]); });
});
it('disables future rounds and ignores a late completion after opt-out', async () => {
  let resolve!: (rows: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'discover_preview_ports' ? new Promise(done => {resolve = done;}) : Promise.resolve([]));
  await mount(); automatic(); await advance(5000); automatic();
  await act(async () => {resolve([row]);});
  await advance(15000);
  expect(calls()).toHaveLength(1);
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
  expect(screen.getByRole('button', {name: 'Discover listeners'})).toHaveProperty('disabled', false);
});
it.each(['unmount', 'revoke'])('holds the same-session gate through %s until actual native settlement', async transition => {
  let resolve!: (rows: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(command => command === 'discover_preview_ports' ? new Promise(done => {resolve = done;}) : Promise.resolve([]));
  const first = await mount(); automatic(); await advance(5000);
  if (transition === 'revoke') {
    await act(async () => {authority(true); authority();});
    await advance(10000); expect(calls()).toHaveLength(1);
  }
  first.unmount();
  await mount();
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await act(async () => {});
  expect(calls()).toHaveLength(1);
  expect(screen.getByRole('alert').textContent).toContain('previous listener scan');
  await act(async () => {resolve([row]);});
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  expect(calls()).toHaveLength(2);
  await act(async () => {resolve([]);});
});
it('snapshots the explicit filter and HTTP choice and requires opt-out before editing', async () => {
  await mount();
  fireEvent.change(screen.getByLabelText('Discover ports'), {target: {value: '3000,8000'}});
  fireEvent.click(screen.getByRole('checkbox', {name: /Check for HTTP/})); automatic();
  expect(screen.getByLabelText('Discover ports')).toHaveProperty('disabled', true);
  expect(screen.getByRole('checkbox', {name: /Check for HTTP/})).toHaveProperty('disabled', true);
  await advance(5000);
  expect(calls()[0][1]).toEqual({sessionId: 'periodic-one', allowPorts: [3000,8000], probeHttp: true});
  automatic();
  expect(screen.getByLabelText('Discover ports')).toHaveProperty('disabled', false);
});
it('rejects invalid opt-in filters without enabling periodic work', async () => {
  await mount(); fireEvent.change(screen.getByLabelText('Discover ports'), {target: {value: '22;command'}}); automatic();
  expect(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})).toHaveProperty('checked', false);
  await advance(10000); expect(calls()).toHaveLength(0);
  expect(screen.getByRole('alert')).toBeTruthy();
});
it('manual discovery resets the periodic cadence after its own settlement', async () => {
  await mount(); automatic(); await advance(4000);
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await act(async () => {});
  await advance(4999); expect(calls()).toHaveLength(1);
  await advance(1); expect(calls()).toHaveLength(2);
});
it('clears the schedule on unmount and does not transfer consent to another session', async () => {
  const view = await mount(); automatic(); await advance(4000);
  view.rerender(<PreviewPanel sessionId="periodic-two" />);
  await act(async () => {});
  expect(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})).toHaveProperty('checked', false);
  await advance(10000); expect(calls()).toHaveLength(0);
  automatic(); view.unmount(); await advance(10000); expect(calls()).toHaveLength(0);
});

it('refreshes listener snapshots without replacing the selected frame or annotation draft', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'list_previews' ? [previewFixture] : [row]);
  await mount();
  const frame = screen.getByTitle('Host browser preview on port 5173');
  fireEvent.load(frame);
  fireEvent.change(screen.getByLabelText('Comment'), {target: {value: 'Keep this literal draft'}});
  fireEvent.change(screen.getByLabelText('Page path'), {target: {value: '/review'}});
  automatic(); await advance(5000); await advance(5000);
  expect(calls()).toHaveLength(2);
  expect(screen.getByTitle('Host browser preview on port 5173')).toBe(frame);
  expect(screen.getByLabelText('Comment')).toHaveProperty('value', 'Keep this literal draft');
  expect(screen.getByLabelText('Page path')).toHaveProperty('value', '/review');
});
