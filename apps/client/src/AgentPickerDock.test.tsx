// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {dialogScreen, fakeTerminal, modelScreen} from './test/agentDialogScreens';
import {act, cleanup, configure, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import AgentPickerDock from './AgentPickerDock';
import {publishComposerControl} from './agentDialogAnswer';
import type {DialogAnswer, TerminalControl} from './ChatTerminalInput';
import {t} from './i18n/core';

configure({asyncUtilTimeout: 5000});
const fixture = dialogScreen, model = modelScreen;
const closed = fixture('model-closed');

const answers: DialogAnswer[] = [];
let screenOf: ReturnType<typeof fakeTerminal>;
let ahead = 0;
/** The bound input of a pane running the picker: arrow keys move the highlight on screen, Enter and Escape close it. */
function bind(react = true) {
  answers.length = 0; ahead = 0;
  const answer = vi.fn(async (body: DialogAnswer) => {
    answers.push(body);
    if (!react) return true;
    if (body.kind === 'pick' && !body.enter) {ahead += body.rows; screenOf.set(model(5 + ahead));}
    else screenOf.set(closed);
    return true;
  });
  const control: TerminalControl = {ready: true, busy: false, failed: false, send: vi.fn(), stop: vi.fn(), retry: vi.fn(), answer, cycleMode: vi.fn(async () => undefined)};
  act(() => publishComposerControl('s', control));
  return answer;
}
function mount(rows: string[], props: Partial<Parameters<typeof AgentPickerDock>[0]> = {}) {
  screenOf = fakeTerminal(rows);
  const onShowTerminal = vi.fn(), guard = vi.fn(async () => true);
  render(<AgentPickerDock sessionId="s" shown terminal={screenOf.terminal} answerable guard={guard} onShowTerminal={onShowTerminal} {...props}/>);
  return {onShowTerminal, guard};
}
const option = (name: string) => screen.getByRole('button', {name: new RegExp(`^${name}`)}) as HTMLButtonElement;
beforeEach(() => {bind();});
afterEach(() => {act(() => publishComposerControl('s', undefined)); cleanup();});

it('shows the open /model dialog as options with the highlighted one marked, and its footer', async () => {
  mount(model(5));
  const card = await screen.findByRole('region', {name: t('agentPickerTitle')});
  expect(within(card).getByRole('heading', {name: 'Select model'})).toBeTruthy();
  expect(within(card).getAllByRole('button').map(button => button.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Sonnet')]));
  expect(option('Haiku').getAttribute('aria-current')).toBe('true');
  expect(option('Opus').getAttribute('aria-current')).toBeNull();
  expect(card.textContent).toContain('Enter to set as default');
});

it('moves the highlight, reads it back, and only then presses Enter, once', async () => {
  mount(model(5));
  await waitFor(() => expect(option('Sonnet').disabled).toBe(false));
  fireEvent.click(option('Sonnet'));
  // The card goes with the dialog it answered.
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  expect(answers).toEqual([{kind: 'pick', rows: -1, enter: false}, {kind: 'pick', rows: 0, enter: true}]);
});

it('presses Enter alone for the option that is already highlighted, and picks with a digit on a desktop keyboard', async () => {
  mount(model(5));
  await waitFor(() => expect(option('Haiku').disabled).toBe(false));
  fireEvent.keyDown(window, {key: '5'});
  await waitFor(() => expect(answers).toEqual([{kind: 'pick', rows: 0, enter: true}]));
});

it('presses no Enter when the dialog does not move to the chosen option', async () => {
  bind(false);
  mount(model(5));
  await waitFor(() => expect(option('Sonnet').disabled).toBe(false));
  fireEvent.click(option('Sonnet'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('agentPickerNotMoved')), {timeout: 8000});
  expect(answers).toEqual([{kind: 'pick', rows: -1, enter: false}]);
}, 12000);

it.each([
  ['the screen no longer shows the dialog that was tapped', ({set}: ReturnType<typeof fakeTerminal>) => set(fixture('rewind-list'), false)],
  ['the pane is no longer the one the agent reported', (_: ReturnType<typeof fakeTerminal>, guard?: ReturnType<typeof vi.fn>) => guard?.mockResolvedValue(false)],
])('sends nothing when %s', async (_, change) => {
  const {guard} = mount(model(5));
  await waitFor(() => expect(option('Sonnet').disabled).toBe(false));
  // The change reaches the screen without the output signal reaching the card, as when the agent redraws under a finger.
  change(screenOf, guard);
  fireEvent.click(option('Sonnet'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('agentPickerStale')));
  expect(answers).toEqual([]);
});

it('finds the chosen option by what it says when the list scrolls as the highlight moves, then presses Enter', async () => {
  const titles = ['One', 'Two', 'Three', 'Four', 'Five'];
  // A window of three sessions: the list scrolls so that the highlighted one stays inside it.
  const list = (first: number, highlighted: number) => ['─'.repeat(40), '  Resume session', '', ...titles.slice(first, first + 3).flatMap((title, index) =>
    [`${first + index === highlighted ? '  ❯ ' : '    '}${title}`, `    ${first + index} days ago`, '']), '  Type to search · Esc to cancel'];
  bind(false);
  const control = vi.fn(async (body: DialogAnswer) => {
    answers.push(body);
    if (body.kind === 'pick' && !body.enter) screenOf.set(list(1, 2));
    else screenOf.set(closed);
    return true;
  });
  act(() => publishComposerControl('s', {ready: true, busy: false, failed: false, send: vi.fn(), stop: vi.fn(), retry: vi.fn(), answer: control, cycleMode: vi.fn(async () => undefined)}));
  mount(list(0, 0));
  await waitFor(() => expect(option('Three').disabled).toBe(false));
  fireEvent.click(option('Three'));
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  // Two rows down from "One"; the redrawn list shows other sessions, with "Three" highlighted, so Enter is pressed.
  expect(answers).toEqual([{kind: 'pick', rows: 2, enter: false}, {kind: 'pick', rows: 0, enter: true}]);
});

it('refuses a tap that lands as the dialog appears', async () => {
  mount(model(5));
  expect(option('Sonnet').disabled).toBe(true);
  fireEvent.click(option('Sonnet'));
  expect(answers).toEqual([]);
});

it('cancels the dialog with Escape through the bound input', async () => {
  mount(fixture('trust'));
  await waitFor(() => expect(screen.getByRole('button', {name: t('agentPickerCancel')}).hasAttribute('disabled')).toBe(false));
  expect(screen.getByRole('region').textContent).toContain('Is this a project you created or one you trust?');
  fireEvent.click(screen.getByRole('button', {name: t('agentPickerCancel')}));
  await waitFor(() => expect(answers).toEqual([{kind: 'request_stop'}]));
});

it('shows the options read-only when the composer is not bound to this terminal, and says to answer in the terminal', async () => {
  const {onShowTerminal} = mount(model(5), {answerable: false});
  await screen.findByRole('region', {name: t('agentPickerTitle')});
  expect(screen.queryByRole('button', {name: /Sonnet/})).toBeNull();
  expect(screen.getByText('Sonnet')).toBeTruthy();
  expect(screen.getByRole('note').textContent).toBe(t('agentPickerTerminalOnly'));
  fireEvent.click(screen.getByRole('button', {name: t('agentViewShowTerminal')}));
  expect(onShowTerminal).toHaveBeenCalledOnce();
});

it('says the agent waits in the terminal for a dialog it cannot read exactly, and sends nothing', async () => {
  const {onShowTerminal} = mount(fixture('permissions-tabs'));
  expect((await screen.findByRole('status')).textContent).toBe(t('agentWaitingInTerminal'));
  expect(screen.queryAllByRole('button').map(button => button.textContent)).toEqual([t('agentViewShowTerminal')]);
  fireEvent.click(screen.getByRole('button'));
  expect(onShowTerminal).toHaveBeenCalledOnce();
  expect(answers).toEqual([]);
});

it('shows nothing for an idle screen, and nothing for a dialog an approval or question card already answers', async () => {
  mount(fixture('idle'));
  await act(async () => {await new Promise(resolve => setTimeout(resolve, 200));});
  expect(screen.queryByRole('region')).toBeNull();
  cleanup();
  mount(fixture('permission'), {waiting: 'approval'});
  await act(async () => {await new Promise(resolve => setTimeout(resolve, 200));});
  expect(screen.queryByRole('region')).toBeNull();
});

it('says the agent waits in the terminal when the hook reports a menu but none is on screen', async () => {
  mount(fixture('idle'), {waiting: 'menu'});
  expect((await screen.findByRole('status')).textContent).toBe(t('agentWaitingInTerminal'));
});

it('follows the dialog as output arrives, and goes away when it closes', async () => {
  mount(fixture('idle'));
  screenOf.set(model(5));
  await screen.findByRole('region', {name: t('agentPickerTitle')});
  screenOf.set(closed);
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
});
