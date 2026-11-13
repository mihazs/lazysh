import {useEffect, useId, useRef, useState, type CSSProperties} from "react";
import {t, useUi} from "./i18n/core";
import {tourSteps, type TourNotes, type TourScene} from "./gestureTourModel";
import {useGestureInsets, useGestureMode} from "./gestureInsets";
import {edgeGestureSettings, usePreferences} from "./preferences";
import "./GestureTour.css";

/** Why a swipe does nothing on this device, and where each one starts: from a handle, from the rows the system gives up, in a strip of the chosen depth. */
function Notes({scene, notes}: {scene: TourScene; notes: TourNotes}) {
  const off = scene === "typing" ? null : notes[scene];
  const mode = useGestureMode(), gestureNavigation = useGestureInsets().navigation === "gesture";
  const where = mode === "handles" ? "gestureTourHandles" : mode === "edges" && gestureNavigation ? "gestureTourAndroidEdge" : null;
  const width = edgeGestureSettings(usePreferences()).zoneWidth;
  return <>
    {where && scene !== "typing" && <p>{t(where)}</p>}
    {scene !== "typing" && !off && <p>{t("gestureTourBand", {width})}</p>}
    {off && <p className="gt-off">{t(off)}</p>}
  </>;
}

type Point = readonly [number, number];
type Box = Record<"x" | "y" | "width" | "height", number>;
/**
 * Where the finger starts and ends, the edge zone it starts in, where the panel it moves rests while hidden and, for the
 * handle style (Android gesture navigation), the handle the finger takes instead: beside the system's Back zone and above its Home zone.
 */
const scenes: Record<TourScene, {from: Point; to: Point; zone: Box; hidden: Point; handle?: Box}> = {
  side: {from: [6, 204], to: [66, 204], zone: {x: 0, y: 0, width: 10, height: 272}, hidden: [-96, 0], handle: {x: 14, y: 184, width: 5, height: 40}},
  bottom: {from: [68, 266], to: [68, 196], zone: {x: 0, y: 262, width: 136, height: 10}, hidden: [0, 100], handle: {x: 48, y: 246, width: 40, height: 5}},
  view: {from: [130, 204], to: [70, 204], zone: {x: 126, y: 0, width: 10, height: 272}, hidden: [136, 0], handle: {x: 117, y: 184, width: 5, height: 40}},
  // Typing: the swipe starts and goes nowhere, and a stop sign shows why.
  typing: {from: [6, 112], to: [40, 112], zone: {x: 0, y: 0, width: 10, height: 272}, hidden: [0, 0]},
};
/** A line from `from` to `to` with a two-stroke head. */
function arrow([x1, y1]: Point, [x2, y2]: Point) {
  const angle = Math.atan2(y2 - y1, x2 - x1), head = (turn: number) => `L${(x2 - 9 * Math.cos(angle + turn)).toFixed(1)} ${(y2 - 9 * Math.sin(angle + turn)).toFixed(1)}`;
  return `M${x1} ${y1}L${x2} ${y2}${head(0.5)}M${x2} ${y2}${head(-0.5)}`;
}
const lines = [26, 40, 54, 68, 82, 96];
/** A stylised phone. Every animation is CSS (see GestureTour.css); reduced motion shows the final frame and an arrow. */
function Phone({scene, off}: {scene: TourScene; off: boolean}) {
  const {to, zone, hidden, handle} = scenes[scene];
  const grip = useGestureMode() === "handles" ? handle : undefined;
  const from: Point = grip ? [grip.x + grip.width / 2, grip.y + grip.height / 2] : scenes[scene].from;
  const clip = useId().replace(/\W/g, "");
  const vars = {"--ax": `${from[0]}px`, "--ay": `${from[1]}px`, "--bx": `${to[0]}px`, "--by": `${to[1]}px`, "--hx": `${hidden[0]}px`, "--hy": `${hidden[1]}px`} as CSSProperties;
  return <svg className="gt-phone" data-scene={scene} data-off={off || undefined} style={vars} viewBox="0 0 160 300" aria-hidden="true" focusable="false">
    <rect className="gt-body" x="3" y="3" width="154" height="294" rx="26" />
    <svg x="12" y="14" width="136" height="272" viewBox="0 0 136 272">
      <defs><clipPath id={clip}><rect width="136" height="272" rx="16" /></clipPath></defs>
      {/* The screen's rounded corners clip the sliding panels. */}
      <g clipPath={`url(#${clip})`}>
      <rect className="gt-screen" width="136" height="272" />
      {lines.map((y, index) => <rect key={y} className="gt-line" x="12" y={y} width={index % 3 === 2 ? 52 : 98 - (index % 2) * 18} height="5" rx="2.5" />)}
      {scene === "side" && <g className="gt-panel"><rect className="gt-sheet" width="96" height="272" />{[34, 62, 90, 118].map(y => <rect key={y} className="gt-item" x="14" y={y} width="62" height="12" rx="6" />)}</g>}
      {scene === "bottom" && <g className="gt-panel"><rect className="gt-sheet" y="172" width="136" height="100" rx="14" /><rect className="gt-item" x="58" y="180" width="20" height="4" rx="2" /><rect className="gt-item" x="14" y="206" width="52" height="30" rx="8" /><rect className="gt-item" x="70" y="206" width="52" height="30" rx="8" /></g>}
      {scene === "view" && <g className="gt-panel"><rect className="gt-sheet" width="136" height="272" /><rect className="gt-item" x="12" y="30" width="88" height="22" rx="8" /><rect className="gt-item" x="36" y="62" width="88" height="34" rx="8" /><rect className="gt-item" x="12" y="106" width="70" height="22" rx="8" /></g>}
      {scene === "typing" && <g>
        <rect className="gt-sheet" y="168" width="136" height="104" />
        {[184, 208, 232].flatMap(y => [14, 40, 66, 92].map(x => <rect key={`${x}-${y}`} className="gt-item" x={x} y={y} width="22" height="16" rx="4" />))}
        <rect className="gt-field" x="10" y="140" width="116" height="20" rx="6" /><rect className="gt-caret" x="18" y="144" width="2" height="12" />
        <g className="gt-blocked"><circle cx="66" cy="112" r="15" /><path d="M55 123 77 101" /></g>
      </g>}
      {scene === "bottom" && <rect className="gt-pill" x="48" y="262" width="40" height="3" rx="1.5" />}
      {grip ? <rect className="gt-handle" rx="2.5" {...grip} /> : <rect className="gt-zone" {...zone} />}
      <path className="gt-arrow" d={arrow(from, to)} />
      <g className="gt-finger"><circle className="gt-ring" r="15" /><circle className="gt-dot" r="7" /></g>
      </g>
    </svg>
  </svg>;
}

/** The animated tour, to render inside a dialog. `finish` runs on Skip, Done and anything else that closes it. */
export default function GestureTour({notes, finish}: {notes: TourNotes; finish: () => void}) {
  useUi();
  const [index, setIndex] = useState(0);
  const body = useId();
  const next = useRef<HTMLButtonElement>(null);
  // The dialog around this loads first and would focus its Close button; the next step is the primary action.
  useEffect(() => next.current?.focus(), []);
  const step = tourSteps[index];
  const last = index === tourSteps.length - 1;
  const off = step.scene !== "typing" && !!notes[step.scene];
  // A touch on the tour is never an edge swipe, whatever is behind it.
  return <div className="gt" data-edge-gestures-ignore>
    <div className="gt-stage"><Phone scene={step.scene} off={off} /></div>
    <div className="gt-copy" aria-live="polite" aria-atomic="true">
      <h3>{t(step.title)}</h3>
      <p id={body}>{t(step.body)}</p>
      <Notes scene={step.scene} notes={notes} />
    </div>
    <div className="gt-progress">
      <span>{t("gestureTourProgress", {current: index + 1, total: tourSteps.length})}</span>
      <span className="gt-dots" aria-hidden="true">{tourSteps.map((_, dot) => <i key={dot} data-active={dot === index || undefined} />)}</span>
    </div>
    <div className="dialog-actions">
      {!last && <button type="button" className="subtle-button" onClick={finish}>{t("gestureTourSkip")}</button>}
      <button type="button" className="primary-button" ref={next} aria-describedby={body} onClick={() => last ? finish() : setIndex(index + 1)}>{t(last ? "gestureTourDone" : "gestureTourNext")}</button>
    </div>
    {last && <p className="gt-replay">{t("gestureTourReplay")}</p>}
  </div>;
}

/** The same content as plain text, for Help and for people who do not want or cannot use the animation. */
export function GestureTourHelp({notes, play}: {notes: TourNotes; play?: () => void}) {
  useUi();
  return <section className="gt-help">
    {tourSteps.map(step => <article key={step.scene}>
      <h3>{t(step.title)}</h3>
      <p>{t(step.body)}</p>
      <Notes scene={step.scene} notes={notes} />
    </article>)}
    {play && <button type="button" onClick={play}>{t("gestureTourPlay")}</button>}
  </section>;
}
