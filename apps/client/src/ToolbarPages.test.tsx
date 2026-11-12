// @vitest-environment jsdom
import {createRef} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import ToolbarPages, {PAGER_VISIBLE_MS, type ToolbarPage} from './ToolbarPages';
import {defaults, savePreferences} from './preferences';

const width = 300;
const pages: ToolbarPage[] = [{id: 'keys', content: 'keys'}, {id: 'tools', content: 'tools'}, {id: 'snippets', content: 'snippets'}];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {configurable: true, get: () => width});
  savePreferences({...defaults, screenReader: false});
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});

function setup() {
  const {container} = render(<ToolbarPages pages={pages} repeats={createRef<number>() as {current: number}} />);
  const track = container.querySelector('.terminal-keys-pages') as HTMLElement;
  let left = 0;
  Object.defineProperty(track, 'scrollLeft', {configurable: true, get: () => left, set: value => {left = value;}});
  const pager = screen.getByRole('group', {name: 'Toolbar pages'});
  return {
    pager,
    /** The toolbar scrolls to `page` the way a swipe does: scroll events with the position, no click. */
    scrollTo(page: number) {act(() => {left = page * width; fireEvent.scroll(track);});},
    dot: (name: string) => screen.getByRole('button', {name}),
  };
}
const shown = (pager: HTMLElement) => pager.getAttribute('data-visible');
const wait = (ms: number) => act(() => {vi.advanceTimersByTime(ms);});

describe('toolbar page indicator', () => {
  it('is hidden until the page changes, yet its buttons stay in the accessibility tree', () => {
    const {pager, dot} = setup();
    expect(shown(pager)).toBe('false');
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Keys page', 'Tools page', 'Snippets page']);
    expect(dot('Keys page').getAttribute('aria-current')).toBe('true');
    expect(dot('Tools page').getAttribute('aria-current')).toBeNull();
    wait(PAGER_VISIBLE_MS * 3);
    expect(shown(pager)).toBe('false');
  });

  it('shows when a swipe reaches another page, stays for the delay after the scrolling stops, then hides', () => {
    const {pager, scrollTo, dot} = setup();
    scrollTo(1);
    expect(shown(pager)).toBe('true');
    expect(dot('Tools page').getAttribute('aria-current')).toBe('true');
    // Still scrolling (a long snap or a slow drag) keeps it: the delay counts from the last movement.
    wait(PAGER_VISIBLE_MS - 1);
    scrollTo(1);
    wait(PAGER_VISIBLE_MS - 1);
    expect(shown(pager)).toBe('true');
    wait(1);
    expect(shown(pager)).toBe('false');
  });

  it('does not show for scrolling that stays on the same page', () => {
    const {pager, scrollTo} = setup();
    scrollTo(0.3);
    expect(shown(pager)).toBe('false');
  });

  it('shows again for the next page change after it hid', () => {
    const {pager, scrollTo} = setup();
    scrollTo(1);
    wait(PAGER_VISIBLE_MS);
    expect(shown(pager)).toBe('false');
    scrollTo(2);
    expect(shown(pager)).toBe('true');
  });

  it('selecting a page with its button switches page and keeps the indicator for the whole delay', () => {
    const {pager, scrollTo, dot} = setup();
    scrollTo(1);
    wait(PAGER_VISIBLE_MS - 10);
    act(() => {fireEvent.click(dot('Snippets page'));});
    expect(dot('Snippets page').getAttribute('aria-current')).toBe('true');
    wait(PAGER_VISIBLE_MS - 1);
    expect(shown(pager)).toBe('true');
    wait(1);
    expect(shown(pager)).toBe('false');
  });

  it('stays shown in screen-reader mode', () => {
    act(() => savePreferences({...defaults, screenReader: true}));
    const {pager, scrollTo} = setup();
    expect(shown(pager)).toBe('true');
    scrollTo(1);
    wait(PAGER_VISIBLE_MS * 2);
    expect(shown(pager)).toBe('true');
  });
});
