// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import HostBrowserPanel from './HostBrowserPanel';
import {uiI18n, t} from './i18n/core';
import {frameBytes, jsonBytes, relayBridge} from './test/hostBrowserRelay';
vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn()}));

const drawImage = vi.fn();
const decoded = vi.fn(async (_blob: Blob) => ({width: 390, height: 700, close: vi.fn()}));
const visibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {configurable: true, value: state});
  document.dispatchEvent(new Event('visibilitychange'));
};
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as never);
  vi.stubGlobal('createImageBitmap', decoded);
});
afterEach(async () => {
  cleanup();
  visibility('visible');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await uiI18n.changeLanguage('en');
});
const state = () => screen.getByRole('status').textContent;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function live(bridge = relayBridge()) {
  render(<HostBrowserPanel sessionId="s1"/>);
  await vi.waitFor(() => expect(bridge.pulls()).toBe(1));
  bridge.push(jsonBytes({type: 'state', state: 'running'}));
  await vi.waitFor(() => expect(bridge.pulls()).toBe(2));
  bridge.push(frameBytes({sequence: 1}));
  await vi.waitFor(() => expect(bridge.calls('host_browser_ack')).toHaveLength(1));
  return bridge;
}

it('starts one browser the size of its stage, is starting until a frame is on the canvas, then live', async () => {
  const bridge = relayBridge();
  render(<HostBrowserPanel sessionId="s1"/>);
  await vi.waitFor(() => expect(bridge.pulls()).toBe(1));
  expect(bridge.calls('host_browser_start')).toEqual([{sessionId: 's1', viewport: {width: 390, height: 700, scale: 1}}]);
  expect(state()).toBe('Starting');
  expect(document.querySelector('canvas')!.hidden).toBe(true);
  bridge.push(jsonBytes({type: 'state', state: 'running'}));
  await vi.waitFor(() => expect(bridge.pulls()).toBe(2));
  expect(state()).toBe('Starting');
  bridge.push(frameBytes({sequence: 7}));
  await vi.waitFor(() => expect(state()).toBe('Live'));
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('img', {name: t('hostBrowserCanvas')}).hasAttribute('hidden')).toBe(false);
  expect(screen.getByRole('button', {name: 'Stop browser'})).toBeTruthy();
});

it('holds one pull at a time and acknowledges each decoded frame once, after it is drawn', async () => {
  const bridge = await live();
  expect(bridge.calls('host_browser_ack')).toEqual([{sessionId: 's1', browserId: 'browser-1', sequence: 1, decodeMs: expect.any(Number)}]);
  for (const sequence of [2, 3]) {
    await vi.waitFor(() => expect(bridge.pulls()).toBe(sequence + 1));
    bridge.push(frameBytes({sequence}));
    await vi.waitFor(() => expect(bridge.calls('host_browser_ack')).toHaveLength(sequence));
  }
  expect(bridge.calls('host_browser_ack').map(ack => ack.sequence)).toEqual([1, 2, 3]);
  expect(drawImage).toHaveBeenCalledTimes(3);
  expect(decoded).toHaveBeenCalledTimes(3);
  await vi.waitFor(() => expect(bridge.pulls()).toBe(5));
});

it('shows the page title and address as text, never as markup', async () => {
  const bridge = await live();
  const title = '<img src=x onerror="alert(1)"><b>Sign in</b>';
  const url = 'https://example.test/?q=<script>alert(1)</script>';
  bridge.push(jsonBytes({type: 'page', title, url}));
  const page = await screen.findByText(title);
  expect(page.tagName).toBe('DD');
  expect(page.querySelector('*')).toBeNull();
  expect(screen.getByText(url).querySelector('*')).toBeNull();
  expect(document.querySelector('img[src="x"], script, b')).toBeNull();
  bridge.push(jsonBytes({type: 'page', title: '', url: 'about:blank'}));
  expect(await screen.findByText('(no title)')).toBeTruthy();
});

it.each([
  ['PageClosed', undefined, 'The page was closed on the host.'],
  ['BrowserExited', undefined, 'The browser on the host exited.'],
  ['PageCrashed', undefined, 'The page crashed on the host.'],
  ['BrowserNotFound', undefined, 'No Chrome or Chromium was found on this host. Install one or put it on the PATH.'],
  ['HostBrowserDisabled', undefined, 'The host browser is turned off on this host. Turn it on in Host settings, then start again.'],
  ['BrowserVersionUnsupported', 'Chrome/99.0', "This host's browser version (Chrome/99.0) is not supported. Chrome or Chromium 111 or newer is needed."],
  ['CompanionRequired', undefined, "This host's companion is too old for the host browser. Update the companion on the host."],
  ['Disconnected', undefined, 'The connection to the host ended.'],
  ['StartTimeout', undefined, 'The browser did not start in time. Start again.'],
  ['SomethingNew', undefined, 'The host browser ended (SomethingNew).'],
])('names why the browser closed: %s', async (reason, detail, words) => {
  const bridge = relayBridge();
  render(<HostBrowserPanel sessionId="s1"/>);
  await vi.waitFor(() => expect(bridge.pulls()).toBe(1));
  bridge.push(jsonBytes({type: 'closed', reason, ...detail ? {detail} : {}}));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(words);
  expect(state()).toBe('Closed');
  await vi.waitFor(() => expect(bridge.calls('host_browser_stop')).toEqual([{sessionId: 's1', browserId: 'browser-1'}]));
  expect(bridge.pulls()).toBe(1);
  expect(screen.getByRole('button', {name: 'Start again'})).toBeTruthy();
});

it('words the states and a reason in every locale, with the relay detail as text', async () => {
  const bridge = relayBridge();
  render(<HostBrowserPanel sessionId="s1"/>);
  await vi.waitFor(() => expect(bridge.pulls()).toBe(1));
  bridge.push(jsonBytes({type: 'closed', reason: 'BrowserVersionUnsupported', detail: '<i>Chrome/99</i>'}));
  await screen.findByRole('alert');
  for (const [locale, closed, stop, text] of [
    ['pt-BR', 'Encerrado', 'Iniciar de novo', 'A versão do navegador deste host (<i>Chrome/99</i>) não é compatível. É preciso Chrome ou Chromium 111 ou mais recente.'],
    ['es', 'Cerrado', 'Iniciar de nuevo', 'La versión del navegador de este host (<i>Chrome/99</i>) no es compatible. Se necesita Chrome o Chromium 111 o más reciente.'],
    ['en', 'Closed', 'Start again', "This host's browser version (<i>Chrome/99</i>) is not supported. Chrome or Chromium 111 or newer is needed."],
  ] as const) {
    await act(async () => { await uiI18n.changeLanguage(locale); });
    expect(state()).toBe(closed);
    expect(screen.getByRole('button', {name: stop})).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(text);
    expect(screen.getByRole('alert').querySelector('i')).toBeNull();
  }
});

it('pauses within a second when the view is hidden, drops the frame on its way and resumes when shown', async () => {
  vi.useFakeTimers();
  const bridge = relayBridge();
  render(<HostBrowserPanel sessionId="s1"/>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  bridge.push(frameBytes({sequence: 1}));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(bridge.calls('host_browser_ack')).toHaveLength(1);

  visibility('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(bridge.calls('host_browser_pause')).toEqual([{sessionId: 's1', browserId: 'browser-1'}]);
  const drawn = drawImage.mock.calls.length, decodes = decoded.mock.calls.length;
  bridge.push(frameBytes({sequence: 2}));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect([drawImage.mock.calls.length, decoded.mock.calls.length, bridge.calls('host_browser_ack').length]).toEqual([drawn, decodes, 1]);
  expect(bridge.calls('host_browser_resume')).toHaveLength(0);

  visibility('visible');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(bridge.calls('host_browser_resume')).toEqual([{sessionId: 's1', browserId: 'browser-1'}]);
  bridge.push(frameBytes({sequence: 3}));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(bridge.calls('host_browser_ack').map(ack => ack.sequence)).toEqual([1, 3]);
  expect(drawImage).toHaveBeenCalledTimes(drawn + 1);
});

it('does not draw or acknowledge a frame whose decoding ended after the view was hidden', async () => {
  const bridge = relayBridge();
  render(<HostBrowserPanel sessionId="s1"/>);
  await vi.waitFor(() => expect(bridge.pulls()).toBe(1));
  let finish!: () => void;
  decoded.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({width: 390, height: 700, close: vi.fn()}); }));
  bridge.push(frameBytes({sequence: 1}));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  visibility('hidden');
  await act(async () => { finish(); });
  await settle();
  expect(drawImage).not.toHaveBeenCalled();
  expect(bridge.calls('host_browser_ack')).toHaveLength(0);
  expect(bridge.calls('host_browser_pause')).toHaveLength(1);
});

it('pauses for the tool being hidden, not only for the app, and starts paused when it was hidden to begin with', async () => {
  const bridge = relayBridge();
  const view = render(<HostBrowserPanel sessionId="s1" visible={false}/>);
  await vi.waitFor(() => expect(bridge.calls('host_browser_pause')).toHaveLength(1));
  expect(view.container.querySelector('section')!.hasAttribute('hidden')).toBe(true);
  bridge.push(frameBytes({sequence: 1}));
  await settle();
  expect(drawImage).not.toHaveBeenCalled();
  view.rerender(<HostBrowserPanel sessionId="s1" visible/>);
  await vi.waitFor(() => expect(bridge.calls('host_browser_resume')).toHaveLength(1));
  view.rerender(<HostBrowserPanel sessionId="s1" visible/>);
  expect(bridge.calls('host_browser_pause')).toHaveLength(1);
});

it('stops the browser when the tool is left, and when its button is pressed, and starts a new one on request', async () => {
  const bridge = await live();
  fireEvent.click(screen.getByRole('button', {name: 'Stop browser'}));
  await vi.waitFor(() => expect(bridge.calls('host_browser_stop')).toEqual([{sessionId: 's1', browserId: 'browser-1'}]));
  expect(state()).toBe('Closed');
  expect(screen.getByText('The browser was stopped.').getAttribute('role')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Start again'}));
  await vi.waitFor(() => expect(bridge.calls('host_browser_start')).toHaveLength(2));
  expect(state()).toBe('Starting');
  cleanup();
  await vi.waitFor(() => expect(bridge.calls('host_browser_stop')).toHaveLength(2));
});

it('stops a browser whose start finished after the tool was left', async () => {
  let begin!: (token: string) => void;
  vi.mocked(invoke).mockImplementation(async command => command === 'host_browser_start' ? new Promise(resolve => { begin = resolve as typeof begin; }) : undefined);
  render(<HostBrowserPanel sessionId="s1"/>);
  cleanup();
  await act(async () => begin('late'));
  await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'host_browser_stop').map(([, args]) => args)).toEqual([{sessionId: 's1', browserId: 'late'}]));
  expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'host_browser_next')).toHaveLength(0);
});

it('fails on a command error or a message it cannot read, and starts again from the button', async () => {
  const bridge = relayBridge();
  render(<HostBrowserPanel sessionId="s1"/>);
  await vi.waitFor(() => expect(bridge.pulls()).toBe(1));
  bridge.push(new Error('The host browser belongs to another session'));
  expect((await screen.findByRole('alert')).textContent).toContain('another session');
  expect(state()).toBe('Failed');
  await vi.waitFor(() => expect(bridge.calls('host_browser_stop')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', {name: 'Start again'}));
  await vi.waitFor(() => expect(bridge.pulls()).toBe(2));
  bridge.push(new Uint8Array([1, 0xff, 0xfe]));
  expect((await screen.findByRole('alert')).textContent).toBe(t('hostBrowserInvalidMessage'));
  expect(state()).toBe('Failed');
  expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull();
});
