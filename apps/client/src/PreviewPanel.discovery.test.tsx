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
// The host answers `null` unless a test says its companion has feature switches.
let hostFeatures: unknown = null;
const native = (discover: () => unknown, fallback: unknown = []) => async (command: string) => command === 'discover_preview_ports' ? discover() : command === 'get_host_features' ? hostFeatures : fallback;
const features = (portScanEnabled: boolean, revision = 1) => ({schemaVersion: 1, revision, simulatorStreamingEnabled: true, portScanEnabled});
const featureReads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_host_features');
const calls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'discover_preview_ports');
// A discovery now reads the host's feature switches first, so it takes more than one microtask round to reach the scan.
const settle = async () => { for (let round = 0; round < 10; round++) await Promise.resolve(); };
const flush = () => act(settle);
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); await settle(); }); };
async function mount() {
  const view = render(<PreviewPanel sessionId="periodic-one" />);
  await flush();
  return view;
}
function automatic() { fireEvent.click(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})); }
beforeEach(() => {
  vi.useFakeTimers(); authority();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  hostFeatures = null;
  vi.mocked(invoke).mockImplementation(native(() => [row]));
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
  vi.mocked(invoke).mockImplementation(native(() => []));
  await advance(5000);
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'start_preview')).toBe(false);
});
it('waits for settlement, drops hidden results, and restarts the cadence when visible', async () => {
  let resolve!: (rows: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(native(() => new Promise(done => {resolve = done;})));
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
  vi.mocked(invoke).mockImplementation(native(() => new Promise(done => {resolve = done;})));
  await mount(); automatic(); await advance(5000); automatic();
  await act(async () => {resolve([row]);});
  await advance(15000);
  expect(calls()).toHaveLength(1);
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
  expect(screen.getByRole('button', {name: 'Discover listeners'})).toHaveProperty('disabled', false);
});
it.each(['unmount', 'revoke'])('holds the same-session gate through %s until actual native settlement', async transition => {
  let resolve!: (rows: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(native(() => new Promise(done => {resolve = done;})));
  const first = await mount(); automatic(); await advance(5000);
  if (transition === 'revoke') {
    await act(async () => {authority(true); authority();});
    await advance(10000); expect(calls()).toHaveLength(1);
  }
  first.unmount();
  await mount();
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await flush();
  expect(calls()).toHaveLength(1);
  expect(screen.getByRole('alert').textContent).toContain('previous listener scan');
  await act(async () => {resolve([row]);});
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await flush();
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
  await flush();
  await advance(4999); expect(calls()).toHaveLength(1);
  await advance(1); expect(calls()).toHaveLength(2);
});
it('clears the schedule on unmount and does not transfer consent to another session', async () => {
  const view = await mount(); automatic(); await advance(4000);
  view.rerender(<PreviewPanel sessionId="periodic-two" />);
  await flush();
  expect(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})).toHaveProperty('checked', false);
  await advance(10000); expect(calls()).toHaveLength(0);
  automatic(); view.unmount(); await advance(10000); expect(calls()).toHaveLength(0);
});

it('refreshes listener snapshots without replacing the selected frame or annotation draft', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'list_previews' ? [previewFixture] : native(() => [row])(command));
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

it('does not scan, and says why, when the host turned port scanning off', async () => {
  hostFeatures = features(false);
  await mount();
  fireEvent.click(screen.getByRole('checkbox', {name: /Check for HTTP/}));
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await flush();
  expect(featureReads()).toHaveLength(1);
  expect(calls()).toHaveLength(0);
  expect(screen.getByText(/Port scanning is turned off on this host/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeNull();
});
it('stops an automatic scan at the host switch after one read, then scans again once the host allows it', async () => {
  hostFeatures = features(false);
  await mount(); automatic(); await advance(5000);
  expect(featureReads()).toHaveLength(1);
  await advance(60000);
  expect(featureReads()).toHaveLength(1);
  expect(calls()).toHaveLength(0);
  expect(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})).toHaveProperty('checked', true);
  hostFeatures = features(true, 2);
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await flush();
  expect(calls()).toHaveLength(1);
  expect(screen.queryByText(/Port scanning is turned off on this host/)).toBeNull();
  expect(screen.getByRole('button', {name: 'node · 127.0.0.1:3000'})).toBeTruthy();
  await advance(5000);
  expect(calls()).toHaveLength(2);
});
it.each([['an enabled switch', features(true)], ['a companion without feature switches', null]])('scans with %s', async (_name, answer) => {
  hostFeatures = answer;
  await mount();
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await flush();
  expect(calls()).toHaveLength(1);
  expect(featureReads()[0][1]).toEqual({sessionId: 'periodic-one'});
});
it.each([[{...features(true), extra: 1}], [{...features(true), portScanEnabled: 'yes'}], [[]]])('does not scan on a malformed host answer %j', async answer => {
  hostFeatures = answer;
  await mount();
  fireEvent.click(screen.getByRole('button', {name: 'Discover listeners'}));
  await flush();
  expect(calls()).toHaveLength(0);
  expect(screen.getByRole('alert').textContent).toContain('Unsupported companion settings');
});
it('remembers the HTTP check and the automatic scan for each host across a reload', async () => {
  const first = render(<PreviewPanel sessionId="connection-1" hostKey="host-a" />);
  await flush();
  fireEvent.click(screen.getByRole('checkbox', {name: /Check for HTTP/})); automatic();
  first.unmount();
  const reloaded = render(<PreviewPanel sessionId="connection-2" hostKey="host-a" />);
  await flush();
  expect(screen.getByRole('checkbox', {name: /Check for HTTP/})).toHaveProperty('checked', true);
  expect(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})).toHaveProperty('checked', true);
  await advance(5000);
  expect(calls().map(([, args]) => args)).toEqual([{sessionId: 'connection-2', allowPorts: null, probeHttp: true}]);
  reloaded.rerender(<PreviewPanel sessionId="connection-3" hostKey="host-b" />);
  await flush();
  expect(screen.getByRole('checkbox', {name: /Check for HTTP/})).toHaveProperty('checked', false);
  expect(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})).toHaveProperty('checked', false);
  await advance(30000);
  expect(calls()).toHaveLength(1);
  reloaded.rerender(<PreviewPanel sessionId="connection-4" hostKey="host-a" />);
  await flush();
  expect(screen.getByRole('checkbox', {name: /Check for HTTP/})).toHaveProperty('checked', true);
});
it.each(['{broken', '{"probe":"yes","automatic":1}'])('treats a damaged remembered choice %s as off', async stored => {
  localStorage.setItem('lazysh.preview.scan.host-a', stored);
  render(<PreviewPanel sessionId="connection-1" hostKey="host-a" />);
  await flush();
  expect(screen.getByRole('checkbox', {name: /Check for HTTP/})).toHaveProperty('checked', false);
  expect(screen.getByRole('checkbox', {name: 'Refresh listeners automatically'})).toHaveProperty('checked', false);
});
