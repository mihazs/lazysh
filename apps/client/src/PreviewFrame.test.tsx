// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PreviewFrame from './PreviewFrame';
import { elementSelection } from './previewAnnotations';
import {previewFixture,previewSelection as selected} from './test/previewData';
const {pickerToken:token,url}=previewFixture;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const capture = vi.fn(); const view = render(<PreviewFrame url={url} port={5173} token={token} onSelection={capture} />);
  const frame = screen.getByTitle('Host browser preview on port 5173') as HTMLIFrameElement;
  const send = vi.spyOn(frame.contentWindow!, 'postMessage'); fireEvent.load(frame);
  const initial = send.mock.calls[0][0];
  function message(action: string, extra = {}, origin = new URL(url).origin, source: MessageEventSource | null = frame.contentWindow) {
    fireEvent(window, new MessageEvent('message', { source, origin, data: { ...initial, action, ...extra } }));
  }
  return { capture, view, frame, send, initial, message };
}
it('validates all untrusted element metadata before it reaches review state', () => {
  expect(elementSelection(selected)).toEqual(selected);
  for (const row of [null, [], { ...selected, selector: '' }, { ...selected, text: 'x'.repeat(301) }, { ...selected, path: '//external/' }, { ...selected, selector: '\x1b[2J' }, { ...selected, rect: { ...selected.rect, x: Infinity } }, { ...selected, rect: { ...selected.rect, width: -1 } }, { ...selected, rect: { ...selected.rect, y: 100001 } }]) expect(() => elementSelection(row)).toThrow();
});
it('requires the exact frame, loopback origin, token, channel, and explicit arming', () => {
  const s = setup();
  for (const [extra, origin, source] of [[{ token: 'wrong' }, undefined, undefined], [{ channel: 'wrong' }, undefined, undefined], [{}, 'http://evil.example', undefined], [{}, undefined, window]] as const) s.message('ready', extra, origin, source);
  expect((screen.getByRole('button', { name: 'Select page element' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...s.initial, action: 'ready' } }));
  expect((screen.getByRole('button', { name: 'Select page element' }) as HTMLButtonElement).disabled).toBe(false);
  s.message('selection', selected); expect(s.capture).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Select page element' }));
  expect((screen.getByRole('button', { name: 'Starting element selection…' }) as HTMLButtonElement).disabled).toBe(true);
  s.message('selection', selected); expect(s.capture).not.toHaveBeenCalled();
  s.message('started');
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...s.initial, action: 'selection', ...selected } }));
  expect(s.capture).toHaveBeenCalledExactlyOnceWith(selected);
  s.message('selection', selected); expect(s.capture).toHaveBeenCalledTimes(1);
  expect(s.send).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'stop' }), new URL(url).origin);
});
it('reload and unmount disarm selection; cancellation never captures page data', () => {
  const s = setup();
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...s.initial, action: 'ready' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Select page element' }));
  s.message('started'); fireEvent.load(s.frame);
  s.message('selection', selected); expect(s.capture).not.toHaveBeenCalled();
  const current = s.send.mock.calls.at(-1)![0];
  expect(current.channel).not.toBe(s.initial.channel);
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...current, action: 'ready' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Select page element' }));
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...current, action: 'started' } }));
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...current, action: 'cancel' } }));
  s.message('selection', selected); expect(s.capture).not.toHaveBeenCalled();
  s.view.unmount(); s.message('selection', selected); expect(s.capture).not.toHaveBeenCalled();
});
it('invalid page data produces a recoverable status, never a captured selection', () => {
  const s = setup();
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...s.initial, action: 'ready' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Select page element' }));
  s.message('started');
  fireEvent(window, new MessageEvent('message', { source: s.frame.contentWindow, origin: new URL(url).origin, data: { ...s.initial, action: 'selection', ...selected, text: '\x00evil' } }));
  expect(s.capture).not.toHaveBeenCalled(); expect(screen.getByRole('status').textContent).toContain('invalid element data');
});
