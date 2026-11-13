// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, renderHook, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GestureTour, {GestureTourHelp} from './GestureTour';
import {gestureTourNotes, gestureTourUseful, gestureTourVersion, tourSteps, useGestureTour, type TourNotes} from './gestureTourModel';
import {defaults, savePreferences} from './preferences';
import {setGestureInsets, unknownInsets} from './gestureInsets';
import {t} from './i18n/core';

// The engine's guard is its own tested module; here it is a switch, as its clock would otherwise decide.
const guard = vi.hoisted(() => ({active: false}));
vi.mock('./textInteraction', () => ({isTextInteractionActive: () => guard.active}));

const all: TourNotes = {side: null, bottom: null, view: null};
beforeEach(() => {localStorage.clear(); guard.active = false; savePreferences({...defaults});});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); setGestureInsets(unknownInsets);});

it('says how deep the strip a swipe starts in is, follows the width preference and leaves out the typing step and a switched-off swipe', async () => {
  const user = userEvent.setup();
  const width = (zoneWidth: number) => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: false, viewSwitch: true, zoneWidth}});
  width(40);
  render(<GestureTour notes={{...all, bottom: 'gestureTourOff'}} finish={vi.fn()} />);
  expect(screen.getByText(t('gestureTourBand', {width: 40}))).toBeTruthy();
  act(() => width(64));
  expect(screen.getByText(t('gestureTourBand', {width: 64}))).toBeTruthy();
  await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
  expect(screen.getByText(t('gestureTourOff'))).toBeTruthy();
  expect(screen.queryByText(t('gestureTourBand', {width: 64}))).toBeNull();
  await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
  expect(screen.getByText(t('gestureTourBand', {width: 64}))).toBeTruthy();
  await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
  expect(screen.queryByText(t('gestureTourBand', {width: 64}))).toBeNull();
});

it('walks the four steps with Next, switches the last one to Done and offers Skip before it', async () => {
  const user = userEvent.setup(), finish = vi.fn();
  render(<GestureTour notes={all} finish={finish} />);
  for (const [index, step] of tourSteps.entries()) {
    expect(screen.getByRole('heading', {name: t(step.title)})).toBeTruthy();
    expect(screen.getByText(t(step.body))).toBeTruthy();
    expect(screen.getByText(t('gestureTourProgress', {current: index + 1, total: tourSteps.length}))).toBeTruthy();
    if (index < tourSteps.length - 1) {
      expect(screen.getByRole('button', {name: t('gestureTourSkip')})).toBeTruthy();
      await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
    }
  }
  expect(screen.queryByRole('button', {name: t('gestureTourSkip')})).toBeNull();
  expect(finish).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', {name: t('gestureTourDone')}));
  expect(finish).toHaveBeenCalledTimes(1);
});

it('finishes on Skip and works from the keyboard alone', async () => {
  const user = userEvent.setup(), finish = vi.fn();
  render(<GestureTour notes={all} finish={finish} />);
  // The primary action holds focus from the start and keeps it across steps.
  expect(document.activeElement).toBe(screen.getByRole('button', {name: t('gestureTourNext')}));
  await user.keyboard(' ');
  expect(screen.getByRole('heading', {name: t('gestureTourBottomTitle')})).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('button', {name: t('gestureTourNext')}));
  await user.tab({shift: true});
  expect(document.activeElement).toBe(screen.getByRole('button', {name: t('gestureTourSkip')}));
  await user.keyboard('{Enter}');
  expect(finish).toHaveBeenCalledTimes(1);
});

it('tells where to switch an off gesture back on, only for that gesture', async () => {
  const user = userEvent.setup();
  render(<GestureTour notes={{...all, bottom: 'gestureTourOff'}} finish={vi.fn()} />);
  expect(screen.queryByText(t('gestureTourOff'))).toBeNull();
  await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
  expect(screen.getByText(t('gestureTourOff'))).toBeTruthy();
  await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
  expect(screen.queryByText(t('gestureTourOff'))).toBeNull();
});

it('prints every step as plain text on the help page, with the animated tour one button away', async () => {
  const user = userEvent.setup(), play = vi.fn();
  render(<GestureTourHelp notes={{...all, view: 'gestureTourOff'}} play={play} />);
  for (const step of tourSteps) expect(screen.getByRole('heading', {name: t(step.title)})).toBeTruthy();
  expect(screen.getAllByText(t('gestureTourOff'))).toHaveLength(1);
  expect(document.querySelector('svg')).toBeNull();
  await user.click(screen.getByRole('button', {name: t('gestureTourPlay')}));
  expect(play).toHaveBeenCalledTimes(1);
});

const settle = () => act(async () => {await vi.advanceTimersByTimeAsync(2000);});

it('opens once per device while eligible and never again after it was dismissed', async () => {
  vi.useFakeTimers();
  const first = renderHook(({eligible}) => useGestureTour(eligible), {initialProps: {eligible: false}});
  await settle();
  expect(first.result.current.open).toBe(false);
  first.rerender({eligible: true});
  expect(first.result.current.open).toBe(false);
  await settle();
  expect(first.result.current.open).toBe(true);
  act(() => first.result.current.dismiss());
  expect(first.result.current.open).toBe(false);
  await settle();
  expect(first.result.current.open).toBe(false);
  first.unmount();
  // A reload is a fresh hook over the same storage.
  const reloaded = renderHook(() => useGestureTour(true));
  await settle();
  expect(reloaded.result.current.open).toBe(false);
});

it('shows again after a newer tour version and on request, and stays quiet when storage is unavailable', async () => {
  vi.useFakeTimers();
  localStorage.setItem('lazysh.gestureTour.v1', String(gestureTourVersion - 1));
  const older = renderHook(() => useGestureTour(true));
  await settle();
  expect(older.result.current.open).toBe(true);
  older.unmount();
  localStorage.setItem('lazysh.gestureTour.v1', String(gestureTourVersion));
  const seen = renderHook(() => useGestureTour(true));
  await settle();
  expect(seen.result.current.open).toBe(false);
  act(() => seen.result.current.show());
  expect(seen.result.current.open).toBe(true);
  seen.unmount();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {throw new Error('blocked');});
  const blocked = renderHook(() => useGestureTour(true));
  await settle();
  expect(blocked.result.current.open).toBe(false);
});

it('says per gesture why a swipe does nothing here: screen reader, Preferences or the kept top bar', () => {
  expect(gestureTourNotes(defaults, false)).toEqual(all);
  expect(gestureTourNotes(defaults, true)).toEqual({...all, side: 'gestureTourTopBar'});
  const off = {...defaults, edgeGestures: {leftMenu: true, bottomMenu: false, viewSwitch: true, zoneWidth: 24}};
  expect(gestureTourNotes(off, true)).toEqual({side: 'gestureTourTopBar', bottom: 'gestureTourOff', view: null});
  // Screen-reader mode replaces every swipe with a button, whatever Preferences say.
  expect(gestureTourNotes({...off, screenReader: true}, false)).toEqual({side: 'gestureTourScreenReader', bottom: 'gestureTourScreenReader', view: 'gestureTourScreenReader'});
});

it('treats "Gesture style: Off" as every swipe switched off', () => {
  const style = (mode: 'auto' | 'off') => ({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: 40, mode}});
  expect(gestureTourNotes(style('auto'), false)).toEqual(all);
  const off = gestureTourNotes(style('off'), false);
  expect(off).toEqual({side: 'gestureTourOff', bottom: 'gestureTourOff', view: 'gestureTourOff'});
  expect(gestureTourUseful(off)).toBe(false);
});

const gestureNavigation = {left: 32, right: 32, bottom: 20, mandatoryBottom: 24, navigation: 'gesture'} as const;
const style = (mode: 'auto' | 'edges') => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: 40, mode}});
const handlesOf = () => document.querySelectorAll('.gt-handle').length;

it('draws the handle and says to start from it on Android gesture navigation, and shows the edge zone elsewhere', async () => {
  const user = userEvent.setup();
  style('auto');
  const plain = render(<GestureTour notes={all} finish={vi.fn()} />);
  expect(handlesOf()).toBe(0);
  expect(document.querySelectorAll('.gt-zone')).toHaveLength(1);
  expect(screen.queryByText(t('gestureTourHandles'))).toBeNull();
  plain.unmount();
  act(() => setGestureInsets(gestureNavigation));
  render(<GestureTour notes={all} finish={vi.fn()} />);
  for (const step of tourSteps.slice(0, 3)) {
    expect(screen.getByRole('heading', {name: t(step.title)})).toBeTruthy();
    expect(handlesOf()).toBe(1);
    expect(document.querySelector('.gt-zone')).toBeNull();
    expect(screen.getByText(t('gestureTourHandles'))).toBeTruthy();
    await user.click(screen.getByRole('button', {name: t('gestureTourNext')}));
  }
  // Typing has no handle to use: the swipe goes nowhere.
  expect(screen.getByRole('heading', {name: t('gestureTourTypingTitle')})).toBeTruthy();
  expect(handlesOf()).toBe(0);
  expect(screen.queryByText(t('gestureTourHandles'))).toBeNull();
});

it('keeps the rows rule for edge swipes on Android gesture navigation and says nothing on three buttons', () => {
  style('edges');
  act(() => setGestureInsets(gestureNavigation));
  const gesture = render(<GestureTour notes={all} finish={vi.fn()} />);
  expect(screen.getByText(t('gestureTourAndroidEdge'))).toBeTruthy();
  expect(screen.queryByText(t('gestureTourHandles'))).toBeNull();
  expect(handlesOf()).toBe(0);
  gesture.unmount();
  act(() => setGestureInsets({...gestureNavigation, left: 0, right: 0, bottom: 0, mandatoryBottom: 0, navigation: 'buttons'}));
  render(<GestureTour notes={all} finish={vi.fn()} />);
  expect(screen.queryByText(t('gestureTourAndroidEdge'))).toBeNull();
});

it('keeps the tour out of the way when no gesture works', () => {
  expect(gestureTourUseful(all)).toBe(true);
  expect(gestureTourUseful({...all, bottom: 'gestureTourOff'})).toBe(true);
  expect(gestureTourUseful({side: 'gestureTourOff', bottom: 'gestureTourOff', view: 'gestureTourScreenReader'})).toBe(false);
});

it('never opens over a keystroke: it waits while the user types or edits text and opens once they stop', async () => {
  vi.useFakeTimers();
  guard.active = true;
  const hook = renderHook(() => useGestureTour(true));
  await settle();
  await settle();
  expect(hook.result.current.open).toBe(false);
  guard.active = false;
  await settle();
  expect(hook.result.current.open).toBe(true);
});
