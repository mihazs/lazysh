import {t} from './i18n/core';
import {useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from "react";
import {usePreferences} from "./preferences";

export type ToolbarPageId = "keys" | "tools" | "snippets";
export type ToolbarPage = {id: ToolbarPageId; content: ReactNode};

/** How long the page indicator stays after the page changes, or after the toolbar stops scrolling. */
export const PAGER_VISIBLE_MS = 2000;

const pageLabels = {keys: "terminalKeysPage", tools: "terminalToolsPage", snippets: "terminalSnippetsPage"} as const;

/**
 * Horizontally swipeable toolbar pages: native scroll snapping moves between them, so a swipe, a
 * trackpad or a focused key all work, and the page indicator below is a row of buttons that selects a
 * page without a gesture. The indicator is hidden until the page changes, then fades in for a moment; it
 * stays reachable by keyboard and screen reader while hidden, and screen-reader mode keeps it shown.
 * `repeats` counts held keys that began repeating; a drag during which one
 * starts belongs to that key and never turns the page.
 */
export default function ToolbarPages({pages, repeats}: {pages: readonly ToolbarPage[]; repeats: RefObject<number>}) {
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, pages.length - 1);
  const indexRef = useRef(index);
  indexRef.current = index;
  const track = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const hideTimer = useRef(0);
  const screenReader = usePreferences().screenReader;
  function reveal() {
    setShown(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShown(false), PAGER_VISIBLE_MS);
  }
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const lastIndex = useRef(index);
  useEffect(() => {
    if (lastIndex.current === index) return;
    lastIndex.current = index;
    reveal();
  }, [index]);

  const show = (next: number) => {if (track.current) track.current.scrollLeft = next * track.current.clientWidth;};
  function select(next: number) {setSelected(next); show(next);}
  // Pages share the track's width, so the page in view is the scroll position in track widths.
  function scrolled() {
    const element = track.current;
    if (!element?.clientWidth) return;
    setSelected(Math.round(element.scrollLeft / element.clientWidth));
    // Still scrolling while the indicator shows: it goes once the toolbar has been still for the whole delay.
    if (shown) reveal();
  }
  // A width change (rotation, the toolbar returning from behind the composer) keeps the page in view.
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    let width = 0;
    const resize = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      show(indexRef.current);
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  // A blocking listener can still cancel the first move of a drag that began while a held key repeats.
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    let started = 0;
    const start = () => {started = repeats.current;};
    const move = (event: TouchEvent) => {if (repeats.current !== started && event.cancelable) event.preventDefault();};
    element.addEventListener("touchstart", start, {passive: true});
    element.addEventListener("touchmove", move, {passive: false});
    return () => {element.removeEventListener("touchstart", start); element.removeEventListener("touchmove", move);};
  }, [repeats]);

  // Not role="tab": session tabs are the only tabs of the workspace, and tests and assistive technology count them.
  return <>
    <div ref={track} className="terminal-keys-pages" onScroll={scrolled}>
      {pages.map(page => <div key={page.id} role="group" aria-label={t(pageLabels[page.id])} className="terminal-keys-page" data-toolbar-page={page.id}>{page.content}</div>)}
    </div>
    <div className="terminal-keys-pager" data-visible={screenReader || shown} role="group" aria-label={t('terminalToolbarPages')}>
      {pages.map((page, position) => <button key={page.id} type="button" aria-current={position === index || undefined} aria-label={t(pageLabels[page.id])} title={t(pageLabels[page.id])}
        // Choosing a page leaves focus, and so the on-screen keyboard, where it was.
        onPointerDown={event => event.preventDefault()}
        onClick={() => {select(position); reveal();}}><span aria-hidden="true" /></button>)}
    </div>
  </>;
}
