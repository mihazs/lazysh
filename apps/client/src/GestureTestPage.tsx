import {useEffect, useState} from 'react';
import {formatNumber, t, useUi, type UiKey} from './i18n/core';
import {bandBox, bottomClearance, edgeBand, handleBox, swipeRows, useGestureInsets, useGestureMode, useViewport, type Box, type GestureInsets, type GestureMode, type NavigationMode} from './gestureInsets';
import {edgeGestureSettings, usePreferences} from './preferences';
import './GestureTestPage.css';

/** How one touch ended: it reached the app, or the system took it (Back, Home or Recents send the app a cancel). */
export type SwipeResult = {from: 'left' | 'right' | 'bottom' | 'leftBand' | 'rightBand' | 'bottomBand' | 'screen'; outcome: 'app' | 'system'; distance: number};
const recorded = 5;

/**
 * Where a touch began: within the system zone (at least `grab` px) of a screen edge, else in the swipe area beside an edge when
 * `zone` is the width of those (the handle mode), else the interior.
 */
export function swipeOrigin(x: number, y: number, view: {width: number; height: number}, insets: GestureInsets, zone: number | null = null): SwipeResult['from'] {
  const grab = 24;
  if (x <= Math.max(insets.left, grab)) return 'left';
  if (view.width - x <= Math.max(insets.right, grab)) return 'right';
  if (view.height - y <= Math.max(bottomClearance(insets), grab)) return 'bottom';
  if (zone === null) return 'screen';
  const inBand = (edge: 'left' | 'right' | 'bottom', distance: number) => {const {from, to} = edgeBand(edge, insets, zone, true); return distance >= from && distance <= to;};
  const rows = swipeRows(insets, view, true);
  const inRows = !!rows && y >= rows.top && y <= rows.bottom;
  if (inRows && inBand('left', x)) return 'leftBand';
  if (inRows && inBand('right', view.width - x)) return 'rightBand';
  return inBand('bottom', view.height - y) ? 'bottomBand' : 'screen';
}

/**
 * Listens to every touch on the page while it is mounted: a finger that lifts reached the app, a real `touchcancel` is the system
 * taking the swipe. The shell's own synthetic cancel (the engine claiming a swipe) carries no touch list and is not counted.
 */
function useSwipeResults(): SwipeResult[] {
  const insets = useGestureInsets(), view = useViewport(), mode = useGestureMode(), zone = edgeGestureSettings(usePreferences()).zoneWidth;
  const band = mode === 'handles' ? zone : null;
  const [results, setResults] = useState<SwipeResult[]>([]);
  useEffect(() => {
    let start: {x: number; y: number; from: SwipeResult['from']} | null = null, last = {x: 0, y: 0};
    const finish = (outcome: SwipeResult['outcome']) => {
      if (!start) return;
      const {x, y, from} = start;
      start = null;
      setResults(previous => [{from, outcome, distance: Math.round(Math.hypot(last.x - x, last.y - y))}, ...previous].slice(0, recorded));
    };
    const begin = (event: TouchEvent) => {
      const point = event.touches[0];
      if (event.touches.length !== 1 || !point) return;
      start = {x: point.clientX, y: point.clientY, from: swipeOrigin(point.clientX, point.clientY, view, insets, band)};
      last = {x: point.clientX, y: point.clientY};
    };
    const move = (event: TouchEvent) => {const point = event.touches[0]; if (point) last = {x: point.clientX, y: point.clientY};};
    const end = (event: TouchEvent) => {
      const point = event.changedTouches?.[0];
      if (point) last = {x: point.clientX, y: point.clientY};
      if (event.touches?.length === 0) finish('app');
    };
    const cancel = (event: TouchEvent) => {if (event.touches) finish('system');};
    const options = {capture: true, passive: true};
    window.addEventListener('touchstart', begin, options);
    window.addEventListener('touchmove', move, options);
    window.addEventListener('touchend', end, options);
    window.addEventListener('touchcancel', cancel, options);
    return () => {
      window.removeEventListener('touchstart', begin, options);
      window.removeEventListener('touchmove', move, options);
      window.removeEventListener('touchend', end, options);
      window.removeEventListener('touchcancel', cancel, options);
    };
  }, [insets, view.width, view.height, band]);
  return results;
}

const navigationLabels = {gesture: 'gestureTestNavigationGesture', buttons: 'gestureTestNavigationButtons', unknown: 'gestureTestNavigationUnknown'} as const satisfies Record<NavigationMode, UiKey>;
const modeLabels = {handles: 'gestureModeHandles', edges: 'gestureModeEdges', off: 'gestureModeOff'} as const satisfies Record<GestureMode, UiKey>;
const originLabels = {
  left: 'gestureTestFromLeft', right: 'gestureTestFromRight', bottom: 'gestureTestFromBottom', leftBand: 'gestureTestFromLeftBand', rightBand: 'gestureTestFromRightBand', bottomBand: 'gestureTestFromBottomBand', screen: 'gestureTestFromScreen',
} as const satisfies Record<SwipeResult['from'], UiKey>;

/** The screen drawn to scale (`scale` diagram px per CSS px) with the live bands of each kind. */
function Diagram({width, height, bands}: {width: number; height: number; bands: {kind: 'system' | 'handle' | 'edge'; box: Box}[]}) {
  const scale = Math.min(1, 220 / Math.max(width, 1));
  return <div className="gesture-test-screen" role="img" aria-label={t('gestureTestDiagram')} style={{width: width * scale, height: height * scale}}>
    {bands.map(({kind, box}, index) => <i key={index} data-kind={kind} style={{left: box.left * scale, top: box.top * scale, width: box.width * scale, height: box.height * scale}} />)}
  </div>;
}

/** Settings > Gestures test: the zones this device reserves for itself right now, and a tester that says whether the system took each swipe. */
export default function GestureTestPage() {
  useUi();
  const insets = useGestureInsets(), view = useViewport(), mode = useGestureMode(), results = useSwipeResults();
  const system = (insets.navigation === 'gesture' ? [
    {left: 0, top: 0, width: insets.left, height: view.height}, {left: view.width - insets.right, top: 0, width: insets.right, height: view.height},
    {left: 0, top: view.height - bottomClearance(insets), width: view.width, height: bottomClearance(insets)},
  ] : []).filter(box => box.width > 0 && box.height > 0);
  const zone = edgeGestureSettings(usePreferences()).zoneWidth;
  // Where a swipe may start: beside the handles, just beyond the system's zones, or at the edge itself.
  const swipeBands = mode === 'off' ? [] : (['left', 'right', 'bottom'] as const).map(edge => bandBox(edge, edgeBand(edge, insets, zone, mode === 'handles'), insets, view, mode === 'handles'));
  const bands: {kind: 'system' | 'handle' | 'edge'; box: Box}[] = [
    ...system.map(box => ({kind: 'system' as const, box})),
    ...swipeBands.flatMap(box => box ? [{kind: 'edge' as const, box}] : []),
    ...(mode === 'handles' ? (['left', 'right', 'bottom'] as const).flatMap(edge => handleBox(edge, insets, view) ?? []).map(box => ({kind: 'handle' as const, box})) : []),
  ];
  return <div className="gesture-test">
    <p>{t('gestureTestIntro')}</p>
    <dl>
      <dt>{t('gestureTestNavigation')}</dt><dd>{t(navigationLabels[insets.navigation])}</dd>
      <dt>{t('gestureTestMode')}</dt><dd>{t(modeLabels[mode])}</dd>
      <dt>{t('gestureTestInsets')}</dt><dd data-testid="gesture-test-insets">{t('gestureTestInsetsValue', {left: formatNumber(insets.left), right: formatNumber(insets.right), bottom: formatNumber(insets.bottom), home: formatNumber(insets.mandatoryBottom)})}</dd>
    </dl>
    <Diagram width={view.width} height={view.height} bands={bands} />
    <ul className="gesture-test-legend">
      <li data-kind="system">{t('gestureTestLegendSystem')}</li>
      <li data-kind="handle">{t('gestureTestLegendHandle')}</li>
      <li data-kind="edge">{t('gestureTestLegendEdge')}</li>
    </ul>
    <h3 className="settings-group-title">{t('gestureTestResults')}</h3>
    <ol className="gesture-test-results" aria-live="polite">
      {results.length === 0 && <li>{t('gestureTestNoResults')}</li>}
      {results.map((result, index) => <li key={index} data-outcome={result.outcome}>
        {t(result.outcome === 'system' ? 'gestureTestResultSystem' : 'gestureTestResultApp', {from: t(originLabels[result.from]), distance: formatNumber(result.distance)})}
      </li>)}
    </ol>
  </div>;
}
