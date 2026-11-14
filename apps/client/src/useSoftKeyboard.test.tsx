// @vitest-environment jsdom
import {act, cleanup, render} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {keyboardCovers, useSoftKeyboard} from './useSoftKeyboard';

const mocks = vi.hoisted(() => ({invoke: vi.fn(), tauri: false}));
vi.mock('@tauri-apps/api/core', () => ({invoke: mocks.invoke, isTauri: () => mocks.tauri}));
let reading: ReturnType<typeof useSoftKeyboard>;
function Probe() {reading = useSoftKeyboard(); return null;}
class Viewport extends EventTarget {height = 800;}
let viewport: Viewport;
const resize = async (height: number, width = window.innerWidth) => {
  viewport.height = height; Object.defineProperty(window, 'innerWidth', {value: width, configurable: true});
  await act(async () => {viewport.dispatchEvent(new Event('resize')); await Promise.resolve();});
};
beforeEach(() => {
  mocks.tauri = false; mocks.invoke.mockReset();
  viewport = new Viewport();
  Object.defineProperty(window, 'visualViewport', {value: viewport, configurable: true});
  Object.defineProperty(window, 'innerWidth', {value: 390, configurable: true});
  vi.stubGlobal('matchMedia', (query: string) => ({matches: query === '(pointer: coarse)'}));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it('counts a keyboard only when the viewport lost a keyboard-sized part of its tallest height', () => {
  expect(keyboardCovers(800, 800)).toBe(false);
  expect(keyboardCovers(800, 700)).toBe(false);
  expect(keyboardCovers(800, 480)).toBe(true);
});
it('follows the keyboard through the viewport, and a rotation starts from the new width', async () => {
  render(<Probe/>);
  expect(reading.open).toBe(false);
  await resize(480); expect(reading.open).toBe(true);
  await resize(800); expect(reading.open).toBe(false);
  // Landscape is shorter by itself: the new width is the new baseline, not a keyboard.
  await resize(360, 800); expect(reading.open).toBe(false);
  await resize(120, 800); expect(reading.open).toBe(true);
});
it('is absent on a desktop pointer and never calls the native shell', async () => {
  vi.stubGlobal('matchMedia', () => ({matches: false}));
  mocks.tauri = true;
  render(<Probe/>);
  await resize(300);
  expect(reading.open).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('trusts Android over the viewport, including a keyboard closed by the system back gesture', async () => {
  mocks.tauri = true;
  mocks.invoke.mockResolvedValue(true);
  render(<Probe/>);
  await resize(480);
  expect(mocks.invoke).toHaveBeenLastCalledWith('soft_keyboard', {action: 'status'}, expect.anything());
  expect(reading.open).toBe(true);
  // Back closes the keyboard while the focused input stays focused; Android says so.
  mocks.invoke.mockResolvedValue(false);
  await resize(800);
  expect(reading.open).toBe(false);
  // The native shell cannot answer (iOS and desktop return null): the viewport decides.
  mocks.invoke.mockResolvedValue(null);
  await resize(480);
  expect(reading.open).toBe(true);
});
it('asks Android to show or hide the keyboard, reads it again once it settled, and ignores a refusal', async () => {
  vi.useFakeTimers();
  mocks.tauri = true;
  mocks.invoke.mockResolvedValue(false);
  render(<Probe/>);
  await act(async () => {reading.request(true); await Promise.resolve();});
  expect(mocks.invoke).toHaveBeenLastCalledWith('soft_keyboard', {action: 'show'}, expect.anything());
  // A keyboard that opened without resizing the page (beside a hardware keyboard) shows up on the re-read.
  mocks.invoke.mockResolvedValue(true);
  await act(async () => {await vi.advanceTimersByTimeAsync(400);});
  expect(mocks.invoke).toHaveBeenLastCalledWith('soft_keyboard', {action: 'status'}, expect.anything());
  expect(reading.open).toBe(true);
  vi.useRealTimers();
  mocks.invoke.mockRejectedValue('soft_keyboard_unavailable');
  await act(async () => {reading.request(false); await Promise.resolve();});
  expect(mocks.invoke).toHaveBeenLastCalledWith('soft_keyboard', {action: 'hide'}, expect.anything());
});
