import {useCallback, useEffect, useState} from "react";
import {isTextInteractionActive} from "./textInteraction";
import type {UiKey} from "./i18n/core";
import {edgeGestureSettings, type EdgeGestureId, type Preferences} from "./preferences";

/**
 * Bump when a gesture is added or changes: a device that finished an older tour sees the new one once.
 * The mark lives outside Preferences on purpose: Preferences sync between devices, and a tour is
 * about what this device's user has already been shown.
 */
export const gestureTourVersion = 1;
export const gestureTourKey = "lazysh.gestureTour.v1";
/** Beat before the first showing, so the tour never lands on the screen that is still connecting. */
const showDelayMs = 900;
/** While the user types or edits text the tour waits and asks again; it never opens over a keystroke. */
const guardRetryMs = 500;

/** Storage that cannot be read counts as seen: a tour that cannot be dismissed for good would nag forever. */
export function gestureTourSeen(): boolean {
  try {
    return Number(localStorage.getItem(gestureTourKey)) >= gestureTourVersion;
  } catch {
    return true;
  }
}
export function markGestureTourSeen() {
  try {
    localStorage.setItem(gestureTourKey, String(gestureTourVersion));
  } catch {
    /* Without storage the tour is never auto-shown, see gestureTourSeen. */
  }
}

/** One tour step per gesture, plus the rule that typing switches the gestures off. */
export type TourScene = "side" | "bottom" | "view" | "typing";
export type TourGesture = Exclude<TourScene, "typing">;
export const tourSteps = [
  {scene: "side", title: "gestureTourSideTitle", body: "gestureTourSideBody"},
  {scene: "bottom", title: "gestureTourBottomTitle", body: "gestureTourBottomBody"},
  {scene: "view", title: "gestureTourViewTitle", body: "gestureTourViewBody"},
  {scene: "typing", title: "gestureTourTypingTitle", body: "gestureTourTypingBody"},
] as const satisfies readonly {scene: TourScene; title: UiKey; body: UiKey}[];

/** Per gesture: null while it works, else the note that says why it does not and where to change that. */
export type TourNote = "gestureTourOff" | "gestureTourTopBar" | "gestureTourScreenReader";
export type TourNotes = Readonly<Record<TourGesture, TourNote | null>>;
const preferenceOf: Record<TourGesture, EdgeGestureId> = {side: "leftMenu", bottom: "bottomMenu", view: "viewSwitch"};

/** What the device does with each gesture right now: screen-reader mode and Preferences switch them off; "Show the top bar" leaves no side menu to open. */
export function gestureTourNotes(preferences: Preferences, topBar: boolean): TourNotes {
  const settings = edgeGestureSettings(preferences);
  const note = (gesture: TourGesture): TourNote | null =>
    preferences.screenReader ? "gestureTourScreenReader"
      : !settings[preferenceOf[gesture]] ? "gestureTourOff"
        : gesture === "side" && topBar ? "gestureTourTopBar" : null;
  return {side: note("side"), bottom: note("bottom"), view: note("view")};
}
/** A tour of gestures that are all off teaches nothing, so it stays out of the way until asked for. */
export const gestureTourUseful = (notes: TourNotes) => Object.values(notes).some(note => !note);

/** The tour auto-opens once per version while `eligible`, and only between keystrokes; `show` reopens it on request. */
export function useGestureTour(eligible: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!eligible || open || gestureTourSeen()) return;
    let timer = window.setTimeout(function attempt() {
      if (isTextInteractionActive()) timer = window.setTimeout(attempt, guardRetryMs);
      else setOpen(true);
    }, showDelayMs);
    return () => window.clearTimeout(timer);
  }, [eligible, open]);
  const show = useCallback(() => setOpen(true), []);
  const dismiss = useCallback(() => {
    markGestureTourSeen();
    setOpen(false);
  }, []);
  return {open, show, dismiss};
}
