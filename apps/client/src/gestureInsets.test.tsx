// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {
  bandBox, bottomClearance, edgeBand, exclusionCapDp, gestureInsetsEvent, getGestureInsets, handleBox, parseGestureInsets, resolveGestureMode, setGestureInsets, sideRow, swipeRows, unknownInsets,
  useGestureInsets, useGestureMode, type GestureInsets,
} from './gestureInsets';
import {defaults, savePreferences} from './preferences';

vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(() => Promise.resolve()), isTauri: vi.fn(() => false)}));

/** Stock Pixel gesture navigation, One UI with high back sensitivity, and a three-button phone. */
const pixel: GestureInsets = {left: 24, right: 24, bottom: 0, mandatoryBottom: 0, navigation: 'gesture'};
const oneUi: GestureInsets = {left: 40, right: 40, bottom: 12, mandatoryBottom: 24, navigation: 'gesture'};
const threeButton: GestureInsets = {...unknownInsets, navigation: 'buttons'};
const phone = {width: 411, height: 891};

beforeEach(() => {setGestureInsets(unknownInsets); savePreferences({...defaults});});
afterEach(() => {cleanup(); vi.mocked(isTauri).mockReturnValue(false);});

describe('the insets the shell reports', () => {
  it('accepts a full report and nothing else', () => {
    expect(parseGestureInsets(oneUi)).toEqual(oneUi);
    expect(parseGestureInsets({...oneUi, extra: 1})).toEqual(oneUi);
    for (const bad of [null, 'x', 5, {}, {...oneUi, left: -1}, {...oneUi, right: NaN}, {...oneUi, bottom: Infinity}, {...oneUi, mandatoryBottom: 5000}, {...oneUi, left: '24'}, {...oneUi, navigation: 'swipe'}, {left: 1, right: 1, bottom: 1, mandatoryBottom: 1}]) {
      expect(parseGestureInsets(bad)).toBeNull();
    }
  });
  it('follows the window event the shell dispatches on every inset change and ignores a malformed one', () => {
    function Zones() {const insets = useGestureInsets(); return <output>{`${insets.navigation}:${insets.left}:${insets.mandatoryBottom}`}</output>;}
    render(<Zones />);
    expect(screen.getByRole('status').textContent).toBe('unknown:0:0');
    act(() => {window.dispatchEvent(new CustomEvent(gestureInsetsEvent, {detail: oneUi}));});
    expect(screen.getByRole('status').textContent).toBe('gesture:40:24');
    act(() => {window.dispatchEvent(new CustomEvent(gestureInsetsEvent, {detail: {...oneUi, left: -3}}));});
    expect(screen.getByRole('status').textContent).toBe('gesture:40:24');
    act(() => {window.dispatchEvent(new CustomEvent(gestureInsetsEvent, {detail: {...oneUi, left: 56}}));});
    expect(screen.getByRole('status').textContent).toBe('gesture:56:24');
  });
  it('reads the current zones from the shell once, when running inside it', async () => {
    vi.resetModules();
    const core = await import('@tauri-apps/api/core');
    vi.mocked(core.isTauri).mockReturnValue(true);
    vi.mocked(core.invoke).mockImplementation(async command => command === 'edge_gesture_insets' ? oneUi : undefined);
    const fresh = await import('./gestureInsets');
    function Zones() {return <output>{fresh.useGestureInsets().left}</output>;}
    render(<Zones />);
    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toBe('40'));
    expect(vi.mocked(core.invoke).mock.calls.filter(([command]) => command === 'edge_gesture_insets')).toHaveLength(1);
    expect(fresh.getGestureInsets()).toEqual(oneUi);
  });
});

describe('the gesture mode', () => {
  it('is handles on gesture navigation and edge swipes everywhere else, unless the user chose', () => {
    expect(resolveGestureMode('auto', pixel)).toBe('handles');
    expect(resolveGestureMode('auto', oneUi)).toBe('handles');
    expect(resolveGestureMode('auto', threeButton)).toBe('edges');
    expect(resolveGestureMode('auto', unknownInsets)).toBe('edges');
    for (const insets of [pixel, threeButton]) {
      expect(resolveGestureMode('handles', insets)).toBe('handles');
      expect(resolveGestureMode('edges', insets)).toBe('edges');
      expect(resolveGestureMode('off', insets)).toBe('off');
    }
  });
  it('is off in screen-reader mode, whatever the choice', () => {
    function Mode() {return <output>{useGestureMode()}</output>;}
    render(<Mode />);
    expect(screen.getByRole('status').textContent).toBe('edges');
    act(() => setGestureInsets(oneUi));
    expect(screen.getByRole('status').textContent).toBe('handles');
    act(() => savePreferences({...defaults, screenReader: true}));
    expect(screen.getByRole('status').textContent).toBe('off');
  });
});

describe('the swipe bands derived from the live zones', () => {
  it('starts beyond the zone the system keeps, 4 dp past it, for every back sensitivity and Home zone', () => {
    for (const [zone, home] of [[24, 24], [32, 24], [40, 32], [56, 48], [96, 64]]) {
      const insets: GestureInsets = {...oneUi, left: zone, right: zone + 8, bottom: home - 4, mandatoryBottom: home};
      expect(edgeBand('left', insets, 40, true)).toEqual({from: zone + 4, to: zone + 44});
      expect(edgeBand('right', insets, 40, true)).toEqual({from: zone + 12, to: zone + 52});
      expect(edgeBand('bottom', insets, 40, true)).toEqual({from: home + 4, to: home + 44});
    }
  });
  it('starts at the edge where the system keeps nothing: three buttons, no report', () => {
    for (const insets of [unknownInsets, threeButton]) {
      for (const edge of ['left', 'right', 'bottom'] as const) expect(edgeBand(edge, insets, 40, true)).toEqual({from: 0, to: 40});
    }
  });
  it('is as thick as asked, and the edge-swipe mode starts at the edge itself above the Home zone', () => {
    expect(edgeBand('left', oneUi, 96, true)).toEqual({from: 44, to: 140});
    expect(edgeBand('left', oneUi, 40, false)).toEqual({from: 0, to: 40});
    expect(edgeBand('bottom', oneUi, 40, false)).toEqual({from: 24, to: 64});
  });
  it('draws a side band over the rows it covers: up to the toolbar for handles, the handle row for edge swipes, all the height with buttons', () => {
    expect(swipeRows(oneUi, phone, true)).toEqual({top: 0, bottom: 891 - 24 - 80});
    expect(swipeRows(oneUi, phone, false)).toEqual(sideRow(oneUi, phone));
    expect(swipeRows(threeButton, phone, true)).toEqual({top: 0, bottom: 891});
    expect(swipeRows(oneUi, {width: 411, height: 100}, true)).toBeNull();
    expect(bandBox('left', edgeBand('left', oneUi, 40, true), oneUi, phone, true)).toEqual({left: 44, top: 0, width: 40, height: 891 - 24 - 80});
    expect(bandBox('right', edgeBand('right', oneUi, 40, true), oneUi, phone, true)).toEqual({left: 411 - 84, top: 0, width: 40, height: 891 - 24 - 80});
    expect(bandBox('bottom', edgeBand('bottom', oneUi, 40, true), oneUi, phone, true)).toEqual({left: 0, top: 891 - 68, width: 411, height: 40});
  });
});

describe('the rows and handles derived from the live zones', () => {
  it('keeps the side rows within the 200 dp Android allows and clear of the Home zone, for any window', () => {
    for (const insets of [unknownInsets, pixel, oneUi, {...oneUi, mandatoryBottom: 96, bottom: 96}]) {
      for (const height of [360, 480, 640, 891, 1200]) {
        const row = sideRow(insets, {width: 411, height});
        if (!row) continue;
        expect(row.bottom - row.top).toBeLessThanOrEqual(exclusionCapDp);
        expect(row.top).toBeGreaterThanOrEqual(0);
        expect(row.bottom).toBeLessThanOrEqual(height - bottomClearance(insets));
      }
    }
    expect(sideRow(oneUi, phone)).toEqual({top: 891 - 24 - 80 - 200, bottom: 891 - 24 - 80});
    expect(sideRow(oneUi, {width: 411, height: 100})).toBeNull();
  });
  it('puts the side handles inside the Back zone plus a margin, and never over it', () => {
    for (const insets of [pixel, oneUi, {...oneUi, left: 56, right: 56}]) {
      const left = handleBox('left', insets, phone)!, right = handleBox('right', insets, phone)!;
      expect(left.left).toBeGreaterThan(insets.left);
      expect(phone.width - (right.left + right.width)).toBeGreaterThan(insets.right);
      const row = sideRow(insets, phone)!;
      for (const box of [left, right]) {
        expect(box.top).toBeGreaterThanOrEqual(row.top);
        expect(box.top + box.height).toBeLessThanOrEqual(row.bottom);
      }
    }
  });
  it('moves with the zones: more back sensitivity moves the side handle inward, a taller Home zone lifts the bottom handle', () => {
    expect(handleBox('left', {...oneUi, left: 56}, phone)!.left - handleBox('left', oneUi, phone)!.left).toBe(16);
    const low = handleBox('bottom', {...oneUi, bottom: 0, mandatoryBottom: 0}, phone)!, high = handleBox('bottom', {...oneUi, bottom: 40, mandatoryBottom: 56}, phone)!;
    expect(low.top - high.top).toBe(56);
  });
  it('draws the bottom handle above the mandatory Home zone, centred', () => {
    for (const insets of [unknownInsets, pixel, oneUi, {...oneUi, bottom: 70, mandatoryBottom: 48}]) {
      const box = handleBox('bottom', insets, phone)!;
      expect(box.top + box.height).toBeLessThan(phone.height - bottomClearance(insets));
      expect(box.left + box.width / 2).toBe(phone.width / 2);
    }
  });
  it('has no side handle where the window is too short to hold one', () => {
    expect(handleBox('left', oneUi, {width: 800, height: 120})).toBeNull();
    expect(handleBox('bottom', oneUi, {width: 800, height: 120})).not.toBeNull();
  });
  it('treats the stored report as the single source of truth', () => {
    setGestureInsets(oneUi);
    expect(getGestureInsets()).toEqual(oneUi);
    const same = {...oneUi};
    setGestureInsets(same);
    expect(getGestureInsets()).toBe(oneUi);
    expect(invoke).not.toHaveBeenCalledWith('edge_gesture_exclusion', expect.anything());
  });
});
