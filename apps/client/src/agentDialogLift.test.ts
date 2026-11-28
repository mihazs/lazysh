import {describe, expect, it} from 'vitest';
import {liftDialog} from './agentDialogLift';
import {dialogScreen, onTmux, runsOn} from './test/agentDialogScreens';

/** Screens captured from Claude Code 2.1.318 in a real 100x40 tmux pane. */
const screen = dialogScreen;
const lift = (name: string) => liftDialog(screen(name));
const dialog = (name: string) => {const result = lift(name); if (result.kind !== 'dialog') throw new Error(`${name}: ${result.kind}`); return result.dialog;};
const recorded = ['model', 'trust', 'theme', 'plan', 'resume', 'rewind-list'];
/** Screens recorded from Claude Code 2.1.326 (see the describe below). */
const claude326 = ['claude-2.1.326-model', 'claude-2.1.326-rewind', 'claude-2.1.326-resume-list'];

describe('liftDialog on recorded Claude Code screens', () => {
  it('treats a changed option description as a different dialog', () => {
    const original = dialog('model');
    const changed = liftDialog(screen('model').map(row => row.replace('Most capable for your hardest and longest-running tasks', 'Different capabilities')));
    if (changed.kind !== 'dialog') throw new Error(`changed model: ${changed.kind}`);
    expect(changed.dialog.options.map(option => option.label)).toEqual(original.options.map(option => option.label));
    expect(changed.dialog.signature).not.toBe(original.signature);
  });
  it('reads the /model picker with its highlighted option and the footer that says what Enter does', () => {
    const found = dialog('model');
    expect(found.title).toBe('Select model');
    expect(found.options.map(option => option.label)).toEqual(['Default (recommended)', 'Opus', 'Fable', 'Sonnet', 'Haiku ✔']);
    expect(found.highlighted).toBe(4);
    expect(found.options[2].detail).toBe('Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok');
    expect(found.hint.at(-1)).toBe('Enter to set as default · s to use this session only · Esc to cancel');
  });

  it('reads the folder trust prompt, whose options have no digits, with the text that explains the choice', () => {
    const found = dialog('trust');
    expect(found.options.map(option => option.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(found.highlighted).toBe(0);
    expect(found.body).toContain('/tmp/lazysh-c/work');
    expect(found.body.join(' ')).toContain('Is this a project you created or one you trust?');
  });

  it('reads /rewind as items of two lines and follows the highlight as it moves', () => {
    const before = dialog('rewind-list');
    const moved = screen('rewind-list').map(row => row.replace('  ❯ (current)', '    (current)').replace('    Reply with only the word ok', '  ❯ Reply with only the word ok'));
    const found = liftDialog(moved);
    if (found.kind !== 'dialog') throw new Error('moved highlight is not a dialog');
    const after = found.dialog;
    expect(before.options).toEqual([{label: 'Reply with only the word ok', detail: 'No code changes'}, {label: '(current)'}]);
    expect([before.highlighted, after.highlighted]).toEqual([1, 0]);
    expect(after.signature).toBe(before.signature);
  });

  it('reads the /resume session list without its project heading or search box as options', () => {
    const found = dialog('resume');
    expect(found.options.map(option => option.label)).toEqual(['AskUserQuestion tool color picker', 'AskUserQuestion tool demo', 'AskUserQuestion multi-select fruit test',
      'AskUserQuestion color picker test', 'x.txt probe file', 'x.txt creation in probe-claude']);
    expect(found.options[0].detail).toBe('17 hours ago · HEAD · 417.9KB');
    expect(found.body).toEqual(['⌕ Search…', 'probe-claude']);
    expect(found.highlighted).toBe(0);
  });

  it('keeps the current-choice check mark out of the layout of the other rows, and ignores the code sample under the list', () => {
    const found = dialog('theme');
    expect(found.options.map(option => option.label)).toEqual(['Auto (match terminal)', 'Dark mode', 'Light mode', 'Dark mode (colorblind-friendly)', 'Light mode (colorblind-friendly)',
      'Dark mode (ANSI colors only)', 'Light mode (ANSI colors only)', 'New custom theme…']);
    expect([found.highlighted, found.hint]).toEqual([1, ['Enter to select · Esc to cancel']]);
  });

  it('reads the plan approval, whose digits are the choice and whose footer has no Esc', () => {
    const found = dialog('plan');
    expect(found.title).toBe("Claude has written up a plan and is ready to execute. Would you like to proceed?");
    expect(found.options.map(option => option.label)).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change']);
    expect(found.highlighted).toBe(0);
  });

  it.each([
    ['a permission prompt, answered by its own card', 'permission'],
    ['a question with its own second list', 'ask-single'],
    ['a tabbed dialog without a highlighted row', 'permissions-tabs'],
    ['the login menu, whose footer does not say what Enter does', 'login'],
    ['the read-only hooks menu, whose Enter only opens a view', 'hooks'],
  ])('refuses %s', (_, name) => expect(lift(name).kind).toBe('unliftable'));

  it.each(['idle', 'model-closed', 'config'])('finds no dialog on the %s screen', name => expect(lift(name).kind).toBe('none'));

  it('recognises the page after a choice, which has a numbered highlighted row but no footer, as a dialog it cannot read', () => {
    expect(lift('rewind-confirm').kind).toBe('unliftable');
    // The prompt box of the idle screen is a highlighted row between two rules, not a dialog.
    expect(liftDialog(['─'.repeat(40), '❯ 1. fix the parser', '─'.repeat(40)]).kind).toBe('none');
    expect(liftDialog(['❯ 1. fix the parser', '', '● Done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40)]).kind).toBe('none');
  });

  it('refuses a list with check boxes, which is a multi-select question', () => {
    const rows = ['─'.repeat(40), 'Pick fruits', '❯ 1. [ ] Apple', '  2. [ ] Pear', '', 'Enter to select · Esc to cancel'];
    expect(liftDialog(rows).kind).toBe('unliftable');
  });

  it('refuses one option, a footer without Enter, and a screen with two highlighted rows', () => {
    const rule = '─'.repeat(40);
    expect(liftDialog([rule, '  Pick', '', '  ❯ Only', '', '  Enter to select · Esc to cancel']).kind).toBe('unliftable');
    expect(liftDialog([rule, '  Pick', '', '  ❯ A', '    B', '', '  Press a key · Esc to cancel']).kind).toBe('unliftable');
    expect(liftDialog([rule, '  Pick', '', '  ❯ A', '  ❯ B', '', '  Enter to select · Esc to cancel']).kind).toBe('unliftable');
  });

  it.each([...recorded, ...claude326])('reads the %s dialog the same under tmux, with blank rows and a status row below its footer', name => {
    expect(liftDialog(onTmux(screen(name)))).toEqual(lift(name));
    expect(liftDialog(onTmux(screen('rewind-confirm'))).kind).toBe('unliftable');
  });

  it.each([...recorded, ...claude326])('names the rows of the %s dialog, from its text to its footer, once on the screen', name => {
    const found = dialog(name);
    expect(found.rows.length).toBeGreaterThanOrEqual(4);
    expect(found.rows[0].trim()).not.toBe('');
    expect(found.rows.at(-1)!.trim()).toMatch(/Esc to (?:cancel|close|go back|dismiss)|ctrl\+g to edit/i);
    expect(runsOn(screen(name), found.rows)).toBe(1);
    // A status row of the multiplexer below the dialog, or a spinner above it, is not part of what a key is sent to.
    expect(runsOn(onTmux(screen(name)), found.rows)).toBe(1);
    // Moving the highlight changes a row of the block, so the host's comparison tells the dialogs apart.
    expect(runsOn(screen(name).map(row => row.replace('❯', ' ')), found.rows)).toBe(0);
  });

  it('is the same dialog when only the highlight moves, and another when an option changes', () => {
    const rows = screen('model');
    const moved = rows.map(row => row.replace('  ❯ 5. Haiku', '    5. Haiku').replace('    4. Sonnet', '  ❯ 4. Sonnet'));
    const found = liftDialog(moved);
    expect(found.kind === 'dialog' && found.dialog.highlighted).toBe(3);
    expect(found.kind === 'dialog' && found.dialog.signature).toBe(dialog('model').signature);
    const renamed = liftDialog(rows.map(row => row.replace('Sonnet', 'Sonnet 4')));
    expect(renamed.kind === 'dialog' && renamed.dialog.signature).not.toBe(dialog('model').signature);
  });
});

/** Claude Code 2.1.326 draws the top of a dialog as a row of ▔ (with a tip drawn over it the first time), pads digits with two spaces, indents the
 * dialog one more column and wraps footers at the pane width. `claude-2.1.326-*.txt` are tmux panes of 100x40 recorded from the real CLI. */
describe('liftDialog on screens recorded from Claude Code 2.1.326', () => {
  const frame = '▔'.repeat(100);
  /** The same screen without the tip Claude draws over the frame (as a Herdr pane read with `agent read --source visible` shows it). */
  const withoutTip = (name: string) => screen(name).map(row => / ▔$/.test(row) ? frame : row);
  /** The 2.1.318 dialog of `name` drawn the way 2.1.326 draws the same list: a ▔ frame and one more column of indent. */
  const redrawn = (name: string) => screen(name).map(row => /^─+$/.test(row) ? frame : row && ` ${row}`);

  it.each([['with the tip over the frame', screen('claude-2.1.326-model')], ['with a plain frame', withoutTip('claude-2.1.326-model')]])('reads the /model picker %s, its More models row and the footer that says what Enter does', (_, rows) => {
    const found = liftDialog(rows);
    if (found.kind !== 'dialog') throw new Error(`/model: ${found.kind}`);
    expect(found.dialog.title).toBe('Select model');
    expect(found.dialog.options.map(option => option.label)).toEqual(['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5 ✔', 'Haiku 5.5', 'More models']);
    expect(found.dialog.options[0].detail).toBe('Opus 5.5 · Best for everyday, complex tasks');
    expect(found.dialog.highlighted).toBe(3);
    expect(found.dialog.hint.at(-1)).toBe('Enter to set as default · s to use this session only · Esc to cancel');
  });

  it('reads /rewind and the /resume list, whose project heading is not an option', () => {
    const rewind = dialog('claude-2.1.326-rewind');
    expect([rewind.title, rewind.options, rewind.highlighted]).toEqual(['Rewind', [{label: 'Reply with only the word ok', detail: 'No code changes'}, {label: '(current)'}], 1]);
    const resume = dialog('claude-2.1.326-resume-list');
    expect([resume.title, resume.body, resume.highlighted]).toEqual(['Resume session', ['⌕ Search…', 'work'], 0]);
    expect(resume.options).toEqual([{label: 'Two', detail: '11 seconds ago · HEAD · 535.9KB'}, {label: '(session)', detail: '1 minute ago · HEAD · 18.6KB'}, {label: 'Ok', detail: '2 minutes ago · HEAD · 530.5KB'}]);
    expect(resume.hint.join(' ')).toContain('Esc to cancel');
  });

  it.each(['theme', 'rewind-list'])('reads the %s list drawn under the ▔ frame as it reads the older drawing', name => {
    const found = liftDialog(redrawn(name));
    if (found.kind !== 'dialog') throw new Error(`${name}: ${found.kind}`);
    expect(found.dialog.options).toEqual(dialog(name).options);
    expect(found.dialog.highlighted).toBe(dialog(name).highlighted);
  });

  it('follows the highlight as it moves and tells another dialog by its options', () => {
    const moved = liftDialog(screen('claude-2.1.326-model').map(row => row.replace(/^ {3}❯ 4\.  /, '     4.  ').replace(/^ {5}2\.  /, '   ❯ 2.  ')));
    expect(moved.kind === 'dialog' && moved.dialog.highlighted).toBe(1);
    expect(moved.kind === 'dialog' && moved.dialog.signature).toBe(dialog('claude-2.1.326-model').signature);
    const renamed = liftDialog(screen('claude-2.1.326-model').map(row => row.replace('Fable 5.2', 'Fable 5.3')));
    expect(renamed.kind === 'dialog' && renamed.dialog.signature).not.toBe(dialog('claude-2.1.326-model').signature);
  });

  it('still refuses what it cannot read exactly, and never answers none for a dialog with a footer', () => {
    // Tabs and a search box, a list of one session under its heading, and an empty list: unliftable, so the banner shows.
    expect(liftDialog(redrawn('permissions-tabs')).kind).toBe('unliftable');
    const [first, ...rest] = screen('claude-2.1.326-resume-list');
    const second = rest.findIndex(row => /^ {5}\(session\)$/.test(row)), footer = rest.findIndex(row => /Ctrl\+A to show all projects/.test(row));
    expect(liftDialog([first, ...rest.slice(0, second), ...rest.slice(footer)]).kind).toBe('unliftable');
    // A footer wrapped at the pane width is one footer, however it breaks.
    const wrapped = [frame, '   Pick one', '', '   ❯ A', '     B', '', '   Enter to select · Esc to', '   cancel'];
    expect(liftDialog(wrapped).kind).toBe('dialog');
    expect(liftDialog(onTmux(wrapped)).kind).toBe('dialog');
  });
});
