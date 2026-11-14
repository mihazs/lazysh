// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { t, uiI18n } from '../i18n/core';
import type { FrameMetadata } from './cdp';
import { HostBrowserInput } from './HostBrowserInput';

const frame: FrameMetadata = { deviceWidth: 390, deviceHeight: 700, offsetTop: 0, timestamp: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 390, bottom: 700, width: 390, height: 700, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await uiI18n.changeLanguage('en');
});

function show(active = true) {
  const send = vi.fn();
  const view = render(<HostBrowserInput active={active} frame={() => frame} send={send}><canvas aria-label="page" /></HostBrowserInput>);
  const again = (next: boolean) => view.rerender(<HostBrowserInput active={next} frame={() => frame} send={send}><canvas aria-label="page" /></HostBrowserInput>);
  return { send, again, ...view };
}
const control = () => screen.getByRole('switch', { name: t('hostBrowserControl') }) as HTMLButtonElement;
const button = (key: 'hostBrowserSelect' | 'hostBrowserKeyboard' | 'hostBrowserZoomPage') => screen.getByRole('button', { name: t(key) }) as HTMLButtonElement;
const keyboardField = () => screen.getByLabelText(t('hostBrowserKeyboardInput')) as HTMLTextAreaElement;
const page = () => screen.getByLabelText('page');
const finger = (id: number, x: number, y: number) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0 });
const tap = (x: number, y: number) => { fireEvent.pointerDown(page(), finger(1, x, y)); fireEvent.pointerUp(page(), finger(1, x, y)); };
const type = (text: string) => { fireEvent.input(keyboardField(), { target: { value: text } }); };
/** Everything a person can do to the view, and what it would send if Control were on. */
function useEverything() {
  tap(100, 200);
  fireEvent.pointerDown(page(), finger(1, 100, 300));
  vi.advanceTimersByTime(600);
  fireEvent.pointerUp(page(), finger(1, 100, 300));
  fireEvent.pointerDown(page(), finger(1, 100, 300));
  fireEvent.pointerMove(page(), finger(1, 100, 100));
  fireEvent.pointerUp(page(), finger(1, 100, 100));
  vi.advanceTimersByTime(100);
  type('héllo 😀');
  fireEvent.keyDown(keyboardField(), { key: 'Enter' });
  fireEvent.keyDown(keyboardField(), { key: 'a', ctrlKey: true });
}

it('sends no input of any kind while Control is off, which is how every session starts', () => {
  const { send } = show();
  expect(control().getAttribute('aria-checked')).toBe('false');
  for (const name of ['hostBrowserSelect', 'hostBrowserKeyboard', 'hostBrowserZoomPage'] as const) expect(button(name).disabled).toBe(true);
  useEverything();
  expect(send).not.toHaveBeenCalled();
});

it('sends the same input once Control is on, and stops at once when it goes off', () => {
  const { send } = show();
  fireEvent.click(control());
  expect(control().getAttribute('aria-checked')).toBe('true');
  tap(100, 200);
  expect(send.mock.calls.map(([message]) => message)).toEqual([
    { type: 'pointer', kind: 'move', x: 100, y: 200, button: 'none', clickCount: 0 },
    { type: 'pointer', kind: 'press', x: 100, y: 200, button: 'left', clickCount: 1 },
    { type: 'pointer', kind: 'release', x: 100, y: 200, button: 'left', clickCount: 1 },
  ]);
  send.mockClear();
  fireEvent.pointerDown(page(), finger(1, 100, 300));
  fireEvent.click(control());
  expect(control().getAttribute('aria-checked')).toBe('false');
  useEverything();
  expect(send).not.toHaveBeenCalled();
});

it('goes back to Control off when the view stops being live, so the next session starts off', () => {
  const { send, again } = show();
  fireEvent.click(control());
  again(false);
  expect(control().getAttribute('aria-checked')).toBe('false');
  expect(control().disabled).toBe(true);
  again(true);
  expect(control().getAttribute('aria-checked')).toBe('false');
  useEverything();
  expect(send).not.toHaveBeenCalled();
});

it('sends keys as key messages and typed text as text, clearing the field each time', () => {
  const { send } = show();
  fireEvent.click(control());
  fireEvent.click(button('hostBrowserKeyboard'));
  expect(document.activeElement).toBe(keyboardField());
  type('héllo 😀');
  expect(keyboardField().value).toBe('');
  fireEvent.keyDown(keyboardField(), { key: 'Enter' });
  fireEvent.keyDown(keyboardField(), { key: 'Backspace', shiftKey: true });
  fireEvent.keyDown(keyboardField(), { key: 'a', ctrlKey: true });
  fireEvent.keyDown(keyboardField(), { key: 'v', ctrlKey: true });
  expect(send.mock.calls.map(([message]) => message)).toEqual([
    { type: 'text', text: 'héllo 😀' },
    { type: 'key', key: 'Enter', modifiers: 0 },
    { type: 'key', key: 'Backspace', modifiers: 8 },
    { type: 'key', key: 'a', modifiers: 2 },
  ]);
});

it('sends a composed character once, when the composition ends, and not its steps or the Enter that picked it', () => {
  const { send } = show();
  fireEvent.click(control());
  fireEvent.compositionStart(keyboardField());
  fireEvent.input(keyboardField(), { target: { value: 'n' }, isComposing: true });
  fireEvent.input(keyboardField(), { target: { value: 'ni' }, isComposing: true });
  fireEvent.keyDown(keyboardField(), { key: 'Enter', isComposing: true });
  expect(send).not.toHaveBeenCalled();
  keyboardField().value = '你';
  fireEvent.compositionEnd(keyboardField(), { data: '你' });
  fireEvent.input(keyboardField(), { isComposing: false });
  expect(send.mock.calls.map(([message]) => message)).toEqual([{ type: 'text', text: '你' }]);
});

it('turns a drag into a mouse drag with Select on, and scrolling with it off', () => {
  const { send } = show();
  fireEvent.click(control());
  fireEvent.pointerDown(page(), finger(1, 100, 300));
  fireEvent.pointerMove(page(), finger(1, 100, 200));
  fireEvent.pointerUp(page(), finger(1, 100, 200));
  expect(send.mock.calls.map(([message]) => message.type)).toEqual(['wheel']);
  send.mockClear();
  fireEvent.click(button('hostBrowserSelect'));
  expect(button('hostBrowserSelect').getAttribute('aria-pressed')).toBe('true');
  fireEvent.pointerDown(page(), finger(1, 100, 300));
  fireEvent.pointerMove(page(), finger(1, 100, 200));
  fireEvent.pointerUp(page(), finger(1, 100, 200));
  expect(send.mock.calls.map(([message]) => message.kind)).toEqual(['move', 'press', 'move', 'release']);
});

it('zooms the frame locally with two fingers, even with Control off, and commits the page zoom only with Control on', () => {
  const { send, container } = show();
  const zoomed = () => (container.querySelector('.host-browser-zoom') as HTMLElement).style.transform;
  fireEvent.pointerDown(page(), finger(1, 150, 350));
  fireEvent.pointerDown(page(), finger(2, 240, 350));
  fireEvent.pointerMove(page(), finger(1, 105, 350));
  fireEvent.pointerMove(page(), finger(2, 285, 350));
  expect(zoomed()).toContain('scale(2)');
  expect(button('hostBrowserZoomPage').disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
  fireEvent.pointerUp(page(), finger(1, 105, 350));
  fireEvent.pointerUp(page(), finger(2, 285, 350));
  fireEvent.click(control());
  fireEvent.click(button('hostBrowserZoomPage'));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'pinch', scale: 2 });
  expect(zoomed()).toContain('scale(1)');
});

it('keeps the browser menu off a long press on the frame', () => {
  show();
  expect(fireEvent.contextMenu(page())).toBe(false);
});

it('names its controls in the language of the app', async () => {
  show();
  await act(() => uiI18n.changeLanguage('pt-BR'));
  expect(screen.getByRole('switch', { name: 'Controle' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ampliar página' })).toBeTruthy();
  await act(() => uiI18n.changeLanguage('es'));
  expect(screen.getByRole('switch', { name: 'Control' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Teclado' })).toBeTruthy();
});
