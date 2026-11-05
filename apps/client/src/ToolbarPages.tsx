import {t} from './i18n/core';
import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent} from "react";
import {nearestPage, pageEdges, touchOverscroll, wheelOverscroll, type PageStep} from "./toolbarPaging";

export type ToolbarPageId = "tools" | "snippets";
export type ToolbarPage = {id: ToolbarPageId; content: ReactNode};

const storageKey = "lazysh.terminal-toolbar-page.v1";
const pageLabels = {tools: "terminalToolsPage", snippets: "terminalSnippetsPage"} as const;

function storedPage(): string | null {
  try {return localStorage.getItem(storageKey);} catch {return null;}
}
function storePage(id: ToolbarPageId) {
  try {localStorage.setItem(storageKey, id);} catch {/* The remembered page is a per-device convenience. */}
}

/**
 * A horizontal carousel of toolbar pages. A slide moves between pages with scroll snapping, and a
 * vertical drag or wheel that continues past a page's last or first row opens the adjacent page.
 */
export default function ToolbarPages({pages}: {pages: readonly ToolbarPage[]}) {
  const [selected, setSelected] = useState(storedPage);
  const id = useId();
  const found = pages.findIndex(page => page.id === selected);
  const index = found < 0 ? 0 : found;
  const indexRef = useRef(index);
  indexRef.current = index;
  const track = useRef<HTMLDivElement>(null);
  const touch = useRef<ReturnType<typeof touchOverscroll> | null>(null);
  const wheel = useRef(wheelOverscroll());
  // A requested page wins over intermediate scroll positions until the smooth scroll arrives.
  const target = useRef<{index: number; timer: ReturnType<typeof setTimeout>} | null>(null);
  const elements = () => Array.from(track.current?.children ?? []) as HTMLElement[];

  function choose(next: number) {
    const page = pages[next]?.id;
    if (!page) return;
    setSelected(page); storePage(page);
  }
  function show(next: number, smooth: boolean) {
    const page = elements()[next], element = track.current;
    if (!page || !element) return;
    if (target.current) clearTimeout(target.current.timer);
    target.current = smooth ? {index: next, timer: setTimeout(() => {target.current = null;}, 700)} : null;
    if (smooth && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) element.scrollTo({left: page.offsetLeft, behavior: "smooth"});
    else element.scrollLeft = page.offsetLeft;
  }
  function go(step: PageStep) {
    const next = indexRef.current + step;
    if (!step || next < 0 || next >= pages.length) return;
    choose(next); show(next, true);
  }
  // Keep the remembered page in view when the toolbar returns from being hidden or the width changes.
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    show(indexRef.current, false);
    const resize = new ResizeObserver(() => {if (!touch.current && !target.current) show(indexRef.current, false);});
    resize.observe(element);
    return () => resize.disconnect();
  }, [pages.length]);
  useEffect(() => () => {if (target.current) clearTimeout(target.current.timer);}, []);

  function scrolled() {
    const element = track.current;
    if (!element) return;
    const nearest = nearestPage(elements().map(page => page.offsetLeft), element.scrollLeft);
    if (target.current) {
      if (nearest !== target.current.index) return;
      clearTimeout(target.current.timer); target.current = null;
    }
    if (nearest !== indexRef.current) choose(nearest);
  }
  const current = () => elements()[indexRef.current];
  // An edge only counts when a page lies beyond it, so the first and last pages never wrap.
  function edges(page: HTMLElement) {
    const {atStart, atEnd} = pageEdges(page);
    return {atStart: atStart && indexRef.current > 0, atEnd: atEnd && indexRef.current < pages.length - 1};
  }
  function touchStart(event: ReactTouchEvent) {
    const point = event.touches[0];
    touch.current = event.touches.length === 1 && point ? touchOverscroll(point.clientX, point.clientY) : null;
  }
  function touchMove(event: ReactTouchEvent) {
    const point = event.touches[0], page = current();
    if (!touch.current || !point || !page || event.touches.length !== 1) {touch.current = null; return;}
    go(touch.current(point.clientX, point.clientY, edges(page)));
  }
  function wheelMove(event: WheelEvent) {
    const page = current();
    if (!page || event.ctrlKey) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.clientHeight : 1;
    go(wheel.current(event.deltaX * scale, event.deltaY * scale, edges(page), performance.now()));
  }
  const ended = () => {touch.current = null;};
  const wheelRef = useRef(wheelMove);
  wheelRef.current = wheelMove;
  // A blocking listener sees the page before the wheel scrolls it, so the notch that reaches the
  // last row never also turns the page.
  useEffect(() => {
    const element = track.current, listener = (event: WheelEvent) => wheelRef.current(event);
    element?.addEventListener("wheel", listener, {passive: false});
    return () => element?.removeEventListener("wheel", listener);
  }, []);

  return <>
    <div ref={track} className="terminal-keys-pages" onScroll={scrolled}
      onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={ended} onTouchCancel={ended}>
      {pages.map((page, position) => <div key={page.id} id={`${id}-${page.id}`} role="tabpanel" className="terminal-keys-page"
        data-toolbar-page={page.id} data-current={position === index} aria-label={t(pageLabels[page.id])}>{page.content}</div>)}
    </div>
    <div className="terminal-keys-pager" role="tablist" aria-label={t('terminalToolbarPages')}>
      {pages.map((page, position) => <button key={page.id} type="button" role="tab" aria-selected={position === index}
        aria-controls={`${id}-${page.id}`} aria-label={t(pageLabels[page.id])} title={t(pageLabels[page.id])}
        // Choosing a page leaves focus, and so the on-screen keyboard, where it was.
        onPointerDown={event => event.preventDefault()}
        onClick={() => {choose(position); show(position, true);}}><span aria-hidden="true" /></button>)}
    </div>
  </>;
}
