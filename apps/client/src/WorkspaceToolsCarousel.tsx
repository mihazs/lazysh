import './WorkspaceToolsCarousel.css';
import {type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {t, useUi} from './i18n/core';

export type WorkspaceToolPage = {id: string; title: string; content: ReactNode};

/** A mouse drag this far, mostly sideways, turns the page like a finger swipe does. */
const MOUSE_SWIPE = 48;
/** Scrolling that stops for this long has settled, where `scrollend` is unavailable. */
const SETTLE_MS = 120;
/** The longest a page turn may animate before its scroll position decides the page again. */
const TURN_MS = 1000;

const motion = (): ScrollBehavior => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
const pageId = (id: string) => `workspace-tools-page-${id}`;
const tabId = (id: string) => `workspace-tools-tab-${id}`;

/**
 * Workspace tools as swipeable pages. Touch swipes use native scroll snapping; mouse
 * drags, the arrows, the page tabs and arrow keys move one page at a time. Only the
 * current page is interactive and exposed to assistive technology.
 */
export function WorkspaceToolsCarousel({pages, initialPage, onPageChange}: {
  pages: WorkspaceToolPage[];
  initialPage?: string;
  onPageChange?: (id: string) => void;
}) {
  useUi();
  const track = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const [selected, setSelected] = useState(() => Math.max(0, pages.findIndex(page => page.id === initialPage)));
  const current = Math.min(selected, pages.length - 1);
  const currentRef = useRef(current);
  currentRef.current = current;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const changed = useRef(onPageChange);
  changed.current = onPageChange;
  const drag = useRef<{x: number; y: number} | null>(null);
  const suppressClick = useRef(false);
  const aligned = useRef(false);
  /** A page turn started by a control, which slow frames must not mistake for a swipe. */
  const turning = useRef<{index: number; until: number} | null>(null);

  function select(next: number, focus = false) {
    const list = pagesRef.current;
    const index = Math.max(0, Math.min(list.length - 1, next));
    const page = list[index];
    if (!page) return;
    setSelected(index);
    changed.current?.(page.id);
    if (focus) tabs.current.get(page.id)?.focus();
  }

  function align(behavior: ScrollBehavior) {
    const node = track.current;
    if (!node || !node.clientWidth) return;
    const left = currentRef.current * node.clientWidth;
    if (Math.abs(node.scrollLeft - left) < 1) return;
    turning.current = behavior === 'smooth' ? {index: currentRef.current, until: performance.now() + TURN_MS} : null;
    if (node.scrollTo) node.scrollTo({left, behavior});
    else node.scrollLeft = left;
  }

  // The first frame shows the remembered page without animating towards it.
  useLayoutEffect(() => { align('auto'); aligned.current = true; }, []);
  useEffect(() => { if (aligned.current) align(motion()); }, [current]);

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    let timer = 0;
    const settle = (ended: boolean) => {
      window.clearTimeout(timer);
      if (!node.clientWidth) return;
      const index = Math.round(node.scrollLeft / node.clientWidth);
      const turn = turning.current;
      if (turn) {
        const arrived = index === turn.index && Math.abs(node.scrollLeft - index * node.clientWidth) < 1;
        if (!arrived && !ended && performance.now() < turn.until) return;
        turning.current = null;
      }
      if (index !== currentRef.current) select(index);
    };
    const scroll = () => { window.clearTimeout(timer); timer = window.setTimeout(() => settle(false), SETTLE_MS); };
    const ended = () => settle(true);
    node.addEventListener('scroll', scroll, {passive: true});
    node.addEventListener('scrollend', ended);
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => align('auto'));
    resize?.observe(node);
    return () => {
      window.clearTimeout(timer);
      node.removeEventListener('scroll', scroll);
      node.removeEventListener('scrollend', ended);
      resize?.disconnect();
    };
  }, []);

  function keydown(event: KeyboardEvent<HTMLButtonElement>) {
    const target = {ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: pages.length - 1}[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target, true);
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    drag.current = event.pointerType === 'mouse' && event.button === 0 ? {x: event.clientX, y: event.clientY} : null;
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    drag.current = null;
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) < MOUSE_SWIPE || Math.abs(dx) <= Math.abs(dy)) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; });
    select(current + (dx < 0 ? 1 : -1));
  }

  const multiple = pages.length > 1;
  const page = pages[current];
  if (!page) return null;
  return (
    <section className="workspace-tools-carousel" aria-roledescription={t('workspaceToolsCarouselRole')} aria-label={t('workspaceToolsPages')}>
      <div className="workspace-tools-pager">
        <h3 className="workspace-tools-page-title" aria-live="polite">{page.title}</h3>
        {multiple && <>
          <button type="button" className="icon-button" aria-label={t('workspaceToolsPreviousPage')} disabled={current === 0} onClick={() => select(current - 1)}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label={t('workspaceToolsNextPage')} disabled={current === pages.length - 1} onClick={() => select(current + 1)}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </>}
      </div>
      <div
        ref={track}
        className="workspace-tools-track"
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerCancel={() => { drag.current = null; }}
        onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
      >
        {pages.map((item, index) => {
          const hidden = index !== current;
          return <div
            key={item.id}
            id={pageId(item.id)}
            className="workspace-tools-page"
            data-tools-page={item.id}
            role={multiple ? 'tabpanel' : 'group'}
            aria-roledescription={t('workspaceToolsSlideRole')}
            aria-label={t('workspaceToolsPagePosition', {page: item.title, current: index + 1, count: pages.length})}
            aria-hidden={hidden || undefined}
            inert={hidden}
          >{item.content}</div>;
        })}
      </div>
      {multiple && <div className="workspace-tools-dots" role="tablist" aria-label={t('workspaceToolsPages')}>
        {pages.map((item, index) => <button
          key={item.id}
          ref={node => { if (node) tabs.current.set(item.id, node); else tabs.current.delete(item.id); }}
          type="button"
          role="tab"
          id={tabId(item.id)}
          aria-controls={pageId(item.id)}
          aria-selected={index === current}
          aria-label={item.title}
          tabIndex={index === current ? 0 : -1}
          onClick={() => select(index)}
          onKeyDown={keydown}
        ><span aria-hidden="true" /></button>)}
      </div>}
    </section>
  );
}
