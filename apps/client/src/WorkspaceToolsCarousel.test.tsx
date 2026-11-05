// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, render, screen, within} from '@testing-library/react';
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
