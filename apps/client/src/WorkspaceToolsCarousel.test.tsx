// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {WorkspaceToolsCarousel, type WorkspaceToolPage} from './WorkspaceToolsCarousel';

afterEach(cleanup);

const page = (id: string): WorkspaceToolPage => ({id, title: id, content: <button type="button">{`${id} action`}</button>});
const shown = () => screen.getByRole('tabpanel').getAttribute('aria-label');

it('keeps showing the selected group when other pages come and go', async () => {
  const user = userEvent.setup(), changed = vi.fn();
  const {rerender} = render(<WorkspaceToolsCarousel pages={['session', 'more', 'application'].map(page)} onPageChange={changed} />);
  await user.click(screen.getByRole('tab', {name: 'application'}));
  expect(shown()).toBe('application, 3 of 3');
  expect(changed).toHaveBeenLastCalledWith('application');
  rerender(<WorkspaceToolsCarousel pages={['session', 'application'].map(page)} onPageChange={changed} />);
  expect(shown()).toBe('application, 2 of 2');
  expect(within(screen.getByRole('tabpanel')).getByRole('button', {name: 'application action'})).toBeTruthy();
  rerender(<WorkspaceToolsCarousel pages={['session', 'more', 'application'].map(page)} onPageChange={changed} />);
  expect(shown()).toBe('application, 3 of 3');
  // A page that disappears hands its place over without recording a turn the user did not make.
  rerender(<WorkspaceToolsCarousel pages={['session', 'more'].map(page)} onPageChange={changed} />);
  expect(shown()).toBe('more, 2 of 2');
  expect(changed).toHaveBeenCalledTimes(1);
});

it('opens on the remembered page and falls back to the first page when it is unavailable', () => {
  render(<WorkspaceToolsCarousel pages={['session', 'more'].map(page)} initialPage="more" />);
  expect(shown()).toBe('more, 2 of 2');
  cleanup();
  render(<WorkspaceToolsCarousel pages={['session', 'more'].map(page)} initialPage="connections" />);
  expect(shown()).toBe('session, 1 of 2');
});

it('finishes a control turn through a late scrollend from the previous turn until the user takes over', async () => {
  // jsdom has no layout: give each track a 300px page width and a scroll position that
  // only an instant scroll moves, so a smooth turn stays in flight until the test lands it.
  const width = 300, positions = new WeakMap<Element, number>();
  const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('workspace-tools-track') ? width : 0; });
  const original = {scrollLeft: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft'), scrollTo: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')};
  Object.defineProperty(Element.prototype, 'scrollLeft', {configurable: true, get(this: Element) { return positions.get(this) ?? 0; }, set(this: Element, value: number) { positions.set(this, value); }});
  Object.defineProperty(Element.prototype, 'scrollTo', {configurable: true, writable: true, value(this: Element, options: ScrollToOptions) { if (options.behavior !== 'smooth') this.scrollLeft = options.left ?? 0; }});
  try {
    const user = userEvent.setup();
    const {container} = render(<WorkspaceToolsCarousel pages={['a', 'b', 'c', 'd'].map(page)} initialPage="d" />);
    const track = container.querySelector('.workspace-tools-track')!;
    const fire = (event: Event) => act(() => { track.dispatchEvent(event); });
    expect(track.scrollLeft).toBe(3 * width);
    await user.click(screen.getByRole('button', {name: 'Previous tools page'}));
    expect(shown()).toBe('c, 3 of 4');
    // The earlier turn's scrollend arrives before the smooth turn to c has moved the track.
    fire(new Event('scrollend'));
    expect(shown()).toBe('c, 3 of 4');
    track.scrollLeft = 2 * width;
    fire(new Event('scrollend'));
    expect(shown()).toBe('c, 3 of 4');
    // A finger on the track takes over a turn in flight, and its swipe decides the page.
    await user.click(screen.getByRole('tab', {name: 'a'}));
    expect(shown()).toBe('a, 1 of 4');
    fire(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'touch'}));
    track.scrollLeft = width;
    fire(new Event('scrollend'));
    expect(shown()).toBe('b, 2 of 4');
  } finally {
    clientWidth.mockRestore();
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
      else delete (Element.prototype as unknown as Record<string, unknown>)[name];
    }
  }
});
