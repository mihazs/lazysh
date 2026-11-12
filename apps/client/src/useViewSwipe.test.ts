// @vitest-environment jsdom
import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {Edge} from './edgeGestures';
import {useViewSwipe, type SwipePage} from './useViewSwipe';

// The engine is mocked at its public contract: the test plays the finger, the hook plays the app.
type Handlers = {onProgress: (...args: number[]) => void; onCommit: () => void; onCancel: () => void};
const engine = vi.hoisted(() => ({right: undefined as unknown as Handlers, back: undefined as unknown as Handlers, enabled: {right: false, back: false}}));
vi.mock('./edgeGestures', () => ({
  edgeSettleMs: () => 200,
  useEdgeGestures: (options: {enabled: boolean; edges: Edge[]; handlers: Handlers}) => {engine.right = options.handlers; engine.enabled.right = options.enabled;},
  useSwipeToClose: (options: {enabled: boolean} & Handlers) => {engine.back = options; engine.enabled.back = options.enabled;},
}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {cleanup(); vi.useRealTimers();});

function mount(page: SwipePage, enabled = true) {
  const body = document.createElement('div');
  Object.defineProperty(body, 'clientWidth', {value: 400});
  const onSwitch = vi.fn<(page: SwipePage) => void>();
  const view = renderHook((props: {page: SwipePage; enabled: boolean}) => useViewSwipe({enabled: props.enabled, scope: 'ssh-1', page: props.page, body: {current: body}, onSwitch}), {initialProps: {page, enabled}});
  return {body, onSwitch, view};
}
const position = (body: HTMLElement) => Number(body.style.getPropertyValue('--view-pos'));

it('offers the right-edge swipe on the terminal and the return swipe on the Agent view, and nothing when disabled', () => {
  mount('terminal'); expect(engine.enabled).toEqual({right: true, back: false});
  mount('agent'); expect(engine.enabled).toEqual({right: false, back: true});
  mount('terminal', false); expect(engine.enabled).toEqual({right: false, back: false});
});

it('moves the pages with the finger and switches to the Agent view only after the settle animation', () => {
  const {body, onSwitch, view} = mount('terminal');
  act(() => engine.right.onProgress(0, 0.25, -100, 0));
  expect(view.result.current).toBe('terminal');
  expect(body.dataset.viewSwipe).toBe('drag'); expect(position(body)).toBe(0.25);
  act(() => engine.right.onProgress(0, 0.5, -400, 0));
  expect(position(body)).toBe(1);
  act(() => engine.right.onCommit());
  expect(body.dataset.viewSwipe).toBe('settle'); expect(onSwitch).not.toHaveBeenCalled();
  act(() => {vi.advanceTimersByTime(200);});
  expect(onSwitch).toHaveBeenCalledExactlyOnceWith('agent');
  expect(view.result.current).toBeNull(); expect(body.dataset.viewSwipe).toBeUndefined();
});

it('returns from the Agent view toward the terminal, and a cancelled swipe settles back without switching', () => {
  const {body, onSwitch} = mount('agent');
  act(() => engine.back.onProgress(0.3, 120, 0));
  expect(position(body)).toBeCloseTo(0.7);
  act(() => engine.back.onCancel());
  expect(position(body)).toBe(1);
  act(() => {vi.advanceTimersByTime(200);});
  expect(onSwitch).not.toHaveBeenCalled();
  act(() => engine.back.onProgress(0.3, 200, 0));
  act(() => engine.back.onCommit());
  expect(position(body)).toBe(0);
  act(() => {vi.advanceTimersByTime(200);});
  expect(onSwitch).toHaveBeenCalledExactlyOnceWith('terminal');
});

it('puts the pages back at once, without switching, when the swipe is disabled mid-drag', () => {
  const {body, onSwitch, view} = mount('terminal');
  act(() => engine.right.onProgress(0, 0.5, -200, 0));
  expect(view.result.current).toBe('terminal');
  view.rerender({page: 'terminal', enabled: false});
  expect(view.result.current).toBeNull(); expect(body.dataset.viewSwipe).toBeUndefined();
  act(() => {vi.advanceTimersByTime(500);});
  expect(onSwitch).not.toHaveBeenCalled();
});
