import {describe, expect, it} from 'vitest';
import {liftDialog} from './agentDialogLift';
import {dialogScreen, onTmux} from './test/agentDialogScreens';

/** Screens captured from Claude Code 2.1.318 in a real 100x40 tmux pane. */
const screen = dialogScreen;
const lift = (name: string) => liftDialog(screen(name));
const dialog = (name: string) => {const result = lift(name); if (result.kind !== 'dialog') throw new Error(`${name}: ${result.kind}`); return result.dialog;};

describe('liftDialog on recorded Claude Code screens', () => {
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

  it.each(['model', 'trust', 'theme', 'plan', 'resume', 'rewind-list'])('reads the %s dialog the same under tmux, with blank rows and a status row below its footer', name => {
    expect(liftDialog(onTmux(screen(name)))).toEqual(lift(name));
    expect(liftDialog(onTmux(screen('rewind-confirm'))).kind).toBe('unliftable');
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
