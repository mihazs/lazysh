import {invoke, isTauri} from '@tauri-apps/api/core';
import {useSyncExternalStore} from 'react';
import type {Edge} from './edgeGestures';
import {edgeGestureSettings, usePreferences, type GestureModePreference} from './preferences';

/** Android caps the height of a system gesture exclusion per edge at this many dp. */
export const exclusionCapDp = 200;
export type NavigationMode = 'gesture' | 'buttons' | 'unknown';
/**
 * How far the system's gesture zones reach into the web viewport from each of its edges, in CSS px (dp), as the Android shell
 * reads them from WindowInsets (`systemGestures()` and `mandatorySystemGestures()`). `bottom` is the Home zone: it cannot be excluded.
 * Everything is 0 and `navigation` is `unknown` wherever nothing owns the edges (desktop, a browser).
 */
export type GestureInsets = {left: number; right: number; bottom: number; mandatoryBottom: number; navigation: NavigationMode};
export const unknownInsets: GestureInsets = {left: 0, right: 0, bottom: 0, mandatoryBottom: 0, navigation: 'unknown'};
/** What the gestures actually do: handles you drag or tap, swipes that start at the screen edge, or nothing. */
export type GestureMode = 'handles' | 'edges' | 'off';

/** The shell dispatches this on `window` whenever the insets change; `detail` is a {@link GestureInsets}. */
export const gestureInsetsEvent = 'lazysh-gesture-insets';
const maxInset = 1000;
const navigations: readonly NavigationMode[] = ['gesture', 'buttons', 'unknown'];

/** The insets the shell reported, or null when the value is not a plausible set of insets. */
export function parseGestureInsets(value: unknown): GestureInsets | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const read = (name: string) => typeof source[name] === 'number' && Number.isFinite(source[name]) && source[name] >= 0 && source[name] <= maxInset ? source[name] : null;
  const [left, right, bottom, mandatoryBottom] = ['left', 'right', 'bottom', 'mandatoryBottom'].map(read);
  const navigation = navigations.find(mode => mode === source.navigation);
  return left === null || right === null || bottom === null || mandatoryBottom === null || !navigation ? null : {left, right, bottom, mandatoryBottom, navigation};
}

let current = unknownInsets;
const listeners = new Set<() => void>();
export const getGestureInsets = () => current;
export function setGestureInsets(next: GestureInsets) {
  if ((Object.keys(next) as (keyof GestureInsets)[]).every(name => next[name] === current[name])) return;
  current = next;
  listeners.forEach(listener => listener());
}
let started = false;
/** Reads the insets once from the shell and follows its changes; nothing runs until a gesture asks. */
function start() {
  if (started) return;
  started = true;
  window.addEventListener(gestureInsetsEvent, event => {
    const next = parseGestureInsets((event as CustomEvent).detail);
    if (next) setGestureInsets(next);
  });
  if (isTauri()) invoke('edge_gesture_insets').then(value => {
    const next = parseGestureInsets(value);
    if (next) setGestureInsets(next);
  }).catch(() => {});
}
export function useGestureInsets(): GestureInsets {
  start();
  return useSyncExternalStore(listener => {listeners.add(listener); return () => void listeners.delete(listener);}, () => current);
}

/** The viewport size, which follows the soft keyboard and rotation. */
export type Viewport = {width: number; height: number};
let size: Viewport = {width: 0, height: 0};
export const viewport = (): Viewport => {
  if (size.width !== window.innerWidth || size.height !== window.innerHeight) size = {width: window.innerWidth, height: window.innerHeight};
  return size;
};
export function useViewport(): Viewport {
  return useSyncExternalStore(listener => {
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  }, viewport);
}

/** The preference resolved against the navigation mode: gesture navigation defaults to handles, everything else to edge swipes. */
export function resolveGestureMode(preference: GestureModePreference, insets: GestureInsets): GestureMode {
  return preference === 'auto' ? (insets.navigation === 'gesture' ? 'handles' : 'edges') : preference;
}
/** The gesture mode for this device, with screen-reader mode as `off` (visible buttons instead). */
export function useGestureMode(): GestureMode {
  const preferences = usePreferences(), insets = useGestureInsets();
  return preferences.screenReader ? 'off' : resolveGestureMode(edgeGestureSettings(preferences).mode, insets);
}

export type Box = {left: number; top: number; width: number; height: number};
export type Row = {top: number; bottom: number};
const handle = {margin: 8, side: {width: 28, height: 96}, bottom: {width: 96, height: 14, lift: 2}};
/** Rows of the side edges stay this far above the bottom gesture zone, clear of the toolbar. */
const rowClearance = 80;
/** The bottom gesture zone as it reaches into the viewport. */
export const bottomClearance = (insets: Pick<GestureInsets, 'bottom' | 'mandatoryBottom'>) => Math.max(insets.bottom, insets.mandatoryBottom);
/** Gap between a system gesture zone and the band an edge swipe may start in, so a touch the system is about to take is never claimed. */
export const bandMargin = 4;

/** Distances from a screen edge, in dp. */
export type Band = {from: number; to: number};
/**
 * Where a touch may begin an edge swipe from `edge`, `thickness` dp wide. The system detects its Back and Home gestures from the screen
 * edge. The handle mode (`past`) starts just beyond the zone the system keeps there, so a touch inside it is never the app's and a touch
 * in the band has no competitor; where the system keeps none (three buttons) that is the edge. The edge-swipe mode starts at the edge
 * itself (above the Home zone at the bottom) and asks the system to give up the side rows it uses.
 */
export function edgeBand(edge: Edge, insets: GestureInsets, thickness: number, past: boolean): Band {
  const system = edge === 'bottom' ? bottomClearance(insets) : insets[edge];
  const from = past ? (system > 0 ? system + bandMargin : 0) : edge === 'bottom' ? system : 0;
  return {from, to: from + thickness};
}

/**
 * The rows of the side bands. With three buttons the whole height. On gesture navigation the handle mode's band reaches all the way up
 * and stops above the toolbar; the edge-swipe mode keeps to the handle rows, the only part of the edge it asks the system to give up.
 */
export function swipeRows(insets: GestureInsets, view: Viewport, past: boolean): Row | null {
  if (insets.navigation !== 'gesture') return {top: 0, bottom: view.height};
  if (!past) return sideRow(insets, view);
  const bottom = view.height - bottomClearance(insets) - rowClearance;
  return bottom > 0 ? {top: 0, bottom} : null;
}

/** A band as a box in viewport px, the side bands over their rows; null where the viewport has no room for one. */
export function bandBox(edge: Edge, band: Band, insets: GestureInsets, view: Viewport, past: boolean): Box | null {
  if (edge === 'bottom') return {left: 0, top: view.height - band.to, width: view.width, height: band.to - band.from};
  const row = swipeRows(insets, view, past);
  return row && {left: edge === 'left' ? band.from : view.width - band.to, top: row.top, width: band.to - band.from, height: row.bottom - row.top};
}

/**
 * The rows of a side edge where a handle sits and an edge swipe may start: at most the 200 dp Android lets an app exclude,
 * above the bottom gesture zone. Null when the viewport is too short to hold one.
 */
export function sideRow(insets: GestureInsets, {height}: Viewport): Row | null {
  const bottom = height - bottomClearance(insets) - rowClearance;
  const top = Math.max(0, bottom - Math.min(exclusionCapDp, height / 3));
  return bottom - top >= handle.side.height / 2 ? {top, bottom} : null;
}

/**
 * Where an edge's handle is drawn and takes touches, in viewport px: the side handles start inside the system back zone plus a margin,
 * and the bottom handle sits just above the Home zone, never over it.
 */
export function handleBox(edge: 'left' | 'right' | 'bottom', insets: GestureInsets, view: Viewport): Box | null {
  if (edge === 'bottom') {
    const {width, height, lift} = handle.bottom;
    return {left: (view.width - width) / 2, top: view.height - bottomClearance(insets) - lift - height, width, height};
  }
  const row = sideRow(insets, view);
  if (!row) return null;
  const {width} = handle.side, height = Math.min(handle.side.height, row.bottom - row.top);
  const inset = (edge === 'left' ? insets.left : insets.right) + handle.margin;
  return {left: edge === 'left' ? inset : view.width - inset - width, top: (row.top + row.bottom) / 2 - height / 2, width, height};
}
