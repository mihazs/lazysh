// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {dialogScreen, fakeTerminal, modelScreen, onTmux} from './test/agentDialogScreens';
import {act, cleanup, configure, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import AgentPickerDock from './AgentPickerDock';
import {publishComposerControl} from './agentDialogAnswer';
import type {DialogAnswer, TerminalControl} from './ChatTerminalInput';
import {t} from './i18n/core';

configure({asyncUtilTimeout: 5000});
const fixture = dialogScreen, model = modelScreen;
const closed = fixture('model-closed');

const answers: DialogAnswer[] = [];
/** The keys sent, without the rows each pick names. */
const keys = () => answers.map(body => body.kind === 'pick' ? {kind: body.kind, rows: body.rows, enter: body.enter} : body);
/** The card is gone and the one key that went out is Enter on the highlighted row. */
const closedByOneEnter = async () => {await waitFor(() => expect(screen.queryByRole('region')).toBeNull()); expect(keys()).toEqual([{kind: 'pick', rows: 0, enter: true}]);};
/** The rows of the /model dialog as a card reads them: from its title to its footer. */
const modelRows = (rows: string[]) => rows.slice(rows.findIndex(row => row.includes('Select model')), rows.findIndex(row => row.includes('Enter to set as default')) + 1).map(row => row.trimEnd());
let screenOf: ReturnType<typeof fakeTerminal>;
let ahead = 0;
/** The bound input of a pane running the picker: arrow keys move the highlight on screen, Enter and Escape close it. */
/** Publishes a bound input whose answers are `answer`, as the composer of a pane would. */
function bindTo(answer: TerminalControl['answer']) {
  const control: TerminalControl = {ready: true, busy: false, failed: false, send: vi.fn(), stop: vi.fn(), retry: vi.fn(), answer, cycleMode: vi.fn(async () => undefined)};
  act(() => publishComposerControl('s', control));
}
function bind(react = true) {
  answers.length = 0; ahead = 0;
  const answer = vi.fn(async (body: DialogAnswer) => {
    answers.push(body);
    if (!react) return true;
    if (body.kind === 'pick' && !body.enter) {ahead += body.rows; screenOf.set(model(5 + ahead));}
    else screenOf.set(closed);
    return true;
  });
  bindTo(answer);
  return answer;
}
function mount(rows: string[], props: Partial<Parameters<typeof AgentPickerDock>[0]> = {}) {
  screenOf = fakeTerminal(rows);
  const onShowTerminal = vi.fn(), guard = vi.fn(async () => true);
  render(<AgentPickerDock sessionId="s" shown terminal={screenOf.terminal} answerable guard={guard} onShowTerminal={onShowTerminal} {...props}/>);
  return {onShowTerminal, guard};
}
/** Taps an option as soon as it can be answered, then waits for the card to go with its dialog. */
async function chooseAndClose(name: string) {
  await waitFor(() => expect(option(name).disabled).toBe(false));
  fireEvent.click(option(name));
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
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
  expect(keys()).toEqual([{kind: 'pick', rows: -1, enter: false}, {kind: 'pick', rows: 0, enter: true}]);
  // Each key names the dialog it is sent to, for the host to compare with the pane just before pressing it: the dialog as it was
  // tapped, then as read back with the chosen option highlighted.
  expect(answers.map(body => body.kind === 'pick' ? body.seen : undefined)).toEqual([modelRows(model(5)), modelRows(model(4))]);
  expect(modelRows(model(5))).not.toEqual(modelRows(model(4)));
});

it('presses Enter alone for the option that is already highlighted, and picks with a digit on a desktop keyboard', async () => {
  vi.useFakeTimers();
  try {
    mount(model(5));
    // The digits are heard by an effect that runs after the render that enables the options: act() runs it, and waitFor can return before it.
    await act(async () => {await vi.advanceTimersByTimeAsync(400);});
    expect(option('Haiku').disabled).toBe(false);
    fireEvent.keyDown(window, {key: '5'});
    await act(async () => {await vi.advanceTimersByTimeAsync(0);});
    expect(keys()).toEqual([{kind: 'pick', rows: 0, enter: true}]);
  } finally {vi.useRealTimers();}
});

it('presses no Enter when the dialog does not move to the chosen option', async () => {
  bind(false);
  mount(model(5));
  await waitFor(() => expect(option('Sonnet').disabled).toBe(false));
  fireEvent.click(option('Sonnet'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('agentPickerNotMoved')), {timeout: 8000});
  expect(keys()).toEqual([{kind: 'pick', rows: -1, enter: false}]);
}, 12000);

it.each([
  ['the screen no longer shows the dialog that was tapped', ({set}: ReturnType<typeof fakeTerminal>) => set(fixture('rewind-list'), false)],
  ['an option description changed after the card was drawn', ({set}: ReturnType<typeof fakeTerminal>) => set(model(5).map(row => row.replace('Efficient for routine tasks', 'Different capabilities')), false)],
  ['the pane is no longer the one the agent reported', (_: ReturnType<typeof fakeTerminal>, guard?: ReturnType<typeof vi.fn>) => guard?.mockResolvedValue(false)],
])('sends nothing when %s', async (_, change) => {
  const {guard} = mount(model(5));
  await waitFor(() => expect(option('Sonnet').disabled).toBe(false));
  // The change reaches the screen without the output signal reaching the card, as when the agent redraws under a finger.
  change(screenOf, guard);
  fireEvent.click(option('Sonnet'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('agentPickerStale')));
  expect(keys()).toEqual([]);
});

it.each([
  ['this screen still shows the dialog', undefined, 'agentPickerFailed'],
  ['this screen has moved on too', () => screenOf.set(closed), 'agentPickerStale'],
] as const)('says so, and presses no Enter, when the host refuses the move because the pane no longer shows the dialog and %s', async (_, redraw, note) => {
  // The host read the pane again right before the key and found something else: it sent nothing and answers false.
  bindTo(vi.fn(async (body: DialogAnswer) => {answers.push(body); redraw?.(); return false;}));
  mount(model(5));
  await waitFor(() => expect(option('Sonnet').disabled).toBe(false));
  fireEvent.click(option('Sonnet'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t(note)));
  expect(keys()).toEqual([{kind: 'pick', rows: -1, enter: false}]);
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
  bindTo(control);
  mount(list(0, 0));
  await chooseAndClose('Three');
  // Two rows down from "One"; the redrawn list shows other sessions, with "Three" highlighted, so Enter is pressed.
  expect(keys()).toEqual([{kind: 'pick', rows: 2, enter: false}, {kind: 'pick', rows: 0, enter: true}]);
});

it('refuses a tap that lands as the dialog appears', async () => {
  mount(model(5));
  expect(option('Sonnet').disabled).toBe(true);
  fireEvent.click(option('Sonnet'));
  expect(keys()).toEqual([]);
});

it('cancels the dialog with Escape through the bound input', async () => {
  mount(fixture('trust'));
  await waitFor(() => expect(screen.getByRole('button', {name: t('agentPickerCancel')}).hasAttribute('disabled')).toBe(false));
  expect(screen.getByRole('region').textContent).toContain('Is this a project you created or one you trust?');
  fireEvent.click(screen.getByRole('button', {name: t('agentPickerCancel')}));
  await waitFor(() => expect(answers).toEqual([{kind: 'dismiss', seen: expect.arrayContaining([expect.stringContaining('Accessing workspace:')])}]));
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
  expect(keys()).toEqual([]);
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

/** Codex's approval prompt as the TUI redraws it with the highlight on option `to` (1 to 3): the real captured screen with the marker moved. */
const codexApproval = (to: number) => onTmux(fixture('codex-approval')).map(row => row.replace(/^[› ] (\d)\. /, (_: string, digit: string) => `${digit === String(to) ? '›' : ' '} ${digit}. `));

it('answers a Codex approval prompt: moves the highlight to the chosen row, reads it back, then presses Enter', async () => {
  bind(false);
  const control = vi.fn(async (body: DialogAnswer) => {
    answers.push(body);
    if (body.kind === 'pick' && !body.enter) {ahead += body.rows; screenOf.set(codexApproval(1 + ahead));} else screenOf.set(onTmux([]));
    return true;
  });
  bindTo(control);
  mount(codexApproval(1), {agent: 'Codex', waiting: 'approval'});
  const card = await screen.findByRole('region', {name: t('agentPickerTitle')});
  expect(within(card).getByRole('heading', {name: 'Would you like to run the following command?'})).toBeTruthy();
  expect(card.textContent).toContain('$ touch note.txt');
  await chooseAndClose('No, and');
  expect(keys()).toEqual([{kind: 'pick', rows: 2, enter: false}, {kind: 'pick', rows: 0, enter: true}]);
});

it('reads each agent\'s own dialogs only: another agent\'s screen is never answerable', async () => {
  const unanswerable = async (rows: string[], agent: string) => {
    mount(rows, {agent});
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 200));});
    expect(screen.queryAllByRole('button').map(button => button.textContent)).not.toContain('Yes, proceed (y)');
    expect(screen.queryAllByRole('button').map(button => button.textContent)).not.toContain('Sonnet');
    cleanup();
  };
  await unanswerable(codexApproval(1), 'Claude Code');
  await unanswerable(model(5), 'Codex');
  await unanswerable(codexApproval(1), 'Gemini');
});

it('says a Codex dialog it cannot read waits in the terminal, even while Codex reports an approval', async () => {
  mount(onTmux(fixture('codex-resume').slice(1, 40)), {agent: 'Codex', waiting: 'approval'});
  expect((await screen.findByRole('status')).textContent).toBe(t('agentWaitingInTerminal'));
  expect(keys()).toEqual([]);
});

it.each(['Grok Build','Gemini CLI','OpenCode'])('says an approval or plan decision of %s waits in the terminal and sends nothing',async agent => {
  for (const waiting of ['approval','plan'] as const) {
    const {onShowTerminal} = mount(closed, {agent, waiting});
    expect((await screen.findByRole('status')).textContent).toBe(t('agentWaitingInTerminal'));
    fireEvent.click(screen.getByRole('button', {name: t('agentViewShowTerminal')}));
    expect(onShowTerminal).toHaveBeenCalledTimes(1);
    cleanup();
  }
  expect(answers).toEqual([]);
});

it('keeps quiet for an agent that reports no approval, and for Claude Code, whose approval has its own card', () => {
  mount(closed, {agent: 'Grok Build'});
  expect(screen.queryByRole('status')).toBeNull();
  cleanup();
  mount(closed, {agent: 'Claude Code', waiting: 'approval'});
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows what a Codex option that keeps a permission rule keeps, and sends nothing until it is confirmed', async () => {
  bind(false);
  const control = vi.fn(async (body: DialogAnswer) => {answers.push(body); screenOf.set(onTmux([])); return true;});
  bindTo(control);
  mount(codexApproval(2), {agent: 'Codex'});
  await waitFor(() => expect(option('Yes, and').disabled).toBe(false));
  fireEvent.click(option('Yes, and'));
  const confirm = screen.getByRole('region', {name: t('agentPickerRememberTitle')});
  expect(confirm.textContent).toContain("Yes, and don't ask again for commands that start with `touch note.txt` (p)");
  fireEvent.click(within(confirm).getByRole('button', {name: t('agentPickerRememberCancel')}));
  expect(screen.queryByRole('region', {name: t('agentPickerRememberTitle')})).toBeNull();
  expect(keys()).toEqual([]);
  fireEvent.click(option('Yes, and'));
  fireEvent.click(screen.getByRole('button', {name: t('agentPickerRememberApply')}));
  await waitFor(() => expect(keys()).toEqual([{kind: 'pick', rows: 0, enter: true}]));
});

/** Codex's question dialog as the TUI redraws it with the highlight on option `to` (1 to 3): the real captured screen with the marker moved. */
const codexQuestion = (name: string, to: number) => onTmux(fixture(name)).map(row => row.replace(/^( {2}[› ]|    ) ?(\d)\. /, (_: string, _lead: string, digit: string) => `  ${digit === String(to) ? '›' : ' '} ${digit}. `));

it('answers the questions Codex asks one after the other, with the arrows and Enter a person presses, and offers no Cancel that would interrupt the turn', async () => {
  bind(false);
  const control = vi.fn(async (body: DialogAnswer) => {
    answers.push(body);
    if (body.kind === 'pick' && !body.enter) {ahead += body.rows; screenOf.set(codexQuestion('codex-question-multi', 1 + ahead));}
    // Enter takes the highlighted option, and Codex goes on to the next question and then closes the dialog.
    else screenOf.set(answers.filter(item => item.kind === 'pick' && item.enter).length === 1 ? codexQuestion('codex-question-last', 1) : onTmux([]));
    return true;
  });
  bindTo(control);
  mount(codexQuestion('codex-question-multi', 1), {agent: 'Codex', waiting: 'question'});
  const first = await screen.findByRole('region', {name: t('agentPickerTitle')});
  expect(within(first).getByRole('heading', {name: 'Which color?'})).toBeTruthy();
  expect(first.textContent).toContain('Question 1/2 (2 unanswered)');
  expect(within(first).queryByRole('button', {name: t('agentPickerCancel')})).toBeNull();
  await waitFor(() => expect(option('Green').disabled).toBe(false));
  fireEvent.click(option('Green'));
  // The next question is its own dialog: the card shows it and waits for its own tap.
  await waitFor(() => expect(screen.getByRole('heading', {name: 'Which size?'})).toBeTruthy());
  expect(keys()).toEqual([{kind: 'pick', rows: 1, enter: false}, {kind: 'pick', rows: 0, enter: true}]);
  ahead = 0;
  await waitFor(() => expect(option('Small').disabled).toBe(false));
  fireEvent.click(option('Small'));
  await waitFor(() => expect(keys().slice(2)).toEqual([{kind: 'pick', rows: 0, enter: true}]));
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
}, 20000);

it('waits for the safety delay again when a new question replaces the previous one', async () => {
  vi.useFakeTimers();
  try {
    mount(codexQuestion('codex-question-multi', 1), {agent: 'Codex', waiting: 'question'});
    await act(async () => {await vi.advanceTimersByTimeAsync(400);});
    expect(option('Green').disabled).toBe(false);
    act(() => screenOf.set(codexQuestion('codex-question-last', 1)));
    await act(async () => {await vi.advanceTimersByTimeAsync(150);});
    expect(option('Small').disabled).toBe(true);
    fireEvent.click(option('Small'));
    expect(answers).toEqual([]);
    await act(async () => {await vi.advanceTimersByTimeAsync(400);});
    expect(option('Small').disabled).toBe(false);
  } finally {vi.useRealTimers();}
});

it('does not send a second answer while the first answer is still pending', async () => {
  bindTo(vi.fn(async (body: DialogAnswer) => {
    answers.push(body);
    await new Promise(resolve => setTimeout(resolve, 250));
    screenOf.set(closed);
    return true;
  }));
  mount(model(5));
  await waitFor(() => expect(option('Haiku').disabled).toBe(false));
  fireEvent.click(option('Haiku'));
  fireEvent.click(option('Haiku'));
  await closedByOneEnter();
});

it('says the notes box of a Codex question waits in the terminal and sends nothing', async () => {
  mount(onTmux(fixture('codex-question-notes')), {agent: 'Codex'});
  expect((await screen.findByRole('status')).textContent).toBe(t('agentWaitingInTerminal'));
  expect(screen.queryAllByRole('button').map(button => button.textContent)).not.toContain('Green');
  expect(keys()).toEqual([]);
});

it.each([
  ['Codex', 'codex-question-notes', /Which color\?/, 'Add notes'],
  ['Claude Code', 'ask-single', /Which color do you want to pick\?/, 'Type something'],
])('shows the live %s question and the terminal affordance when no answer card is available', async (agent, file, question, input) => {
  const {onShowTerminal} = mount(onTmux(fixture(file)), {agent, waiting: 'question'});
  expect((await screen.findByRole('status')).textContent).toBe(t('agentWaitingInTerminal'));
  expect(screen.getByText(question).textContent).toContain(input);
  fireEvent.click(screen.getByRole('button', {name: t('agentViewShowTerminal')}));
  expect(onShowTerminal).toHaveBeenCalledOnce();
  expect(keys()).toEqual([]);
});

it('updates the visible unliftable question when the next question arrives', async () => {
  const rows = fixture('codex-question-notes');
  mount(onTmux(rows), {agent: 'Codex', waiting: 'question'});
  expect(await screen.findByText(/Which color\?/)).toBeTruthy();
  act(() => screenOf.set(onTmux(rows.map(row => row.replace('Which color?', 'Which fruit?').replace('Question 1/1', 'Question 2/2')))));
  expect(await screen.findByText(/Which fruit\?/)).toBeTruthy();
  expect(screen.queryByText(/Which color\?/)).toBeNull();
  expect(keys()).toEqual([]);
});

it('keeps a new answer pending when an older question finishes late', async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const first = new Promise<void>(resolve => {releaseFirst = resolve;});
  const second = new Promise<void>(resolve => {releaseSecond = resolve;});
  const answer = vi.fn(async (body: DialogAnswer) => {
    answers.push(body);
    if (answers.length === 1) {screenOf.set(codexQuestion('codex-question-last', 1)); await first;}
    else {await second; screenOf.set(onTmux([]));}
    return true;
  });
  bindTo(answer);
  mount(codexQuestion('codex-question-multi', 1), {agent: 'Codex', waiting: 'question'});
  await waitFor(() => expect(option('Red').disabled).toBe(false));
  fireEvent.click(option('Red'));
  await waitFor(() => expect(screen.getByRole('heading', {name: 'Which size?'})).toBeTruthy());
  await waitFor(() => expect(option('Small').disabled).toBe(false));
  fireEvent.click(option('Small'));
  await waitFor(() => expect(answers).toHaveLength(2));
  await act(async () => {releaseFirst(); await new Promise(resolve => setTimeout(resolve, 350));});
  expect(option('Small').disabled).toBe(true);
  fireEvent.click(option('Small'));
  expect(answers).toHaveLength(2);
  await act(async () => {releaseSecond();});
  await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
});

it.each(['screen', 'composer binding'] as const)('sends nothing if the %s changes while the pane guard is pending', async change => {
  let release!: (allowed: boolean) => void;
  const pending = new Promise<boolean>(resolve => {release = resolve;});
  const {guard} = mount(codexQuestion('codex-question-multi', 1), {agent: 'Codex', waiting: 'question'});
  guard.mockReturnValue(pending);
  await waitFor(() => expect(option('Red').disabled).toBe(false));
  fireEvent.click(option('Red'));
  await waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
  if (change === 'screen') act(() => screenOf.set(codexQuestion('codex-question-last', 1), false));
  else bindTo(vi.fn(async (body: DialogAnswer) => {answers.push(body); return true;}));
  await act(async () => {release(true);});
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t('agentPickerStale')));
  expect(answers).toEqual([]);
});

it('releases a replaced guard without letting its result release the new answer', async () => {
  let releaseOld!: (allowed: boolean) => void, releaseNew!: (allowed: boolean) => void;
  const oldGuard = vi.fn(() => new Promise<boolean>(resolve => {releaseOld = resolve;}));
  const newGuard = vi.fn(() => new Promise<boolean>(resolve => {releaseNew = resolve;}));
  bindTo(vi.fn(async (body: DialogAnswer) => {answers.push(body); screenOf.set(closed); return true;}));
  screenOf = fakeTerminal(model(5));
  const props = {sessionId: 's', shown: true, terminal: screenOf.terminal, answerable: true, onShowTerminal: vi.fn()};
  const view = render(<AgentPickerDock {...props} guard={oldGuard}/>);
  await waitFor(() => expect(option('Haiku').disabled).toBe(false));
  fireEvent.click(option('Haiku'));
  await waitFor(() => expect(oldGuard).toHaveBeenCalledTimes(1));
  view.rerender(<AgentPickerDock {...props} guard={newGuard}/>);
  await waitFor(() => expect(option('Haiku').disabled).toBe(false));
  fireEvent.click(option('Haiku'));
  await waitFor(() => expect(newGuard).toHaveBeenCalledTimes(1));
  await act(async () => {releaseOld(true);});
  expect(option('Haiku').disabled).toBe(true);
  expect(answers).toEqual([]);
  await act(async () => {releaseNew(true);});
  await closedByOneEnter();
});
