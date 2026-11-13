import {describe, expect, it} from 'vitest';
import {liftCodexDialog} from './agentCodexLift';
import {dialogScreen} from './test/agentDialogScreens';

/** Screens captured from Codex CLI 0.167.0 in a real 110x40 tmux pane. */
const dialog = (rows: string[]) => {const result = liftCodexDialog(rows); if (result.kind !== 'dialog') throw new Error(result.kind); return result.dialog;};
const recorded = (name: string) => dialog(dialogScreen(name));

describe('liftCodexDialog on recorded Codex screens', () => {
  it('reads the command approval with the lines that explain it, and does not take the history above it for part of it', () => {
    const found = recorded('codex-approval');
    expect(found.title).toBe('Would you like to run the following command?');
    expect(found.body).toEqual(['Environment: local', 'Reason: Allow creating probe.txt in the workspace?', '$ touch probe.txt']);
    expect(found.options.map(option => option.label)).toEqual(['Yes, proceed (y)', "Yes, and don't ask again for commands that start with `touch probe.txt` (p)", 'No, and tell Codex what to do differently (esc)']);
    expect([found.highlighted, found.hint]).toEqual([0, ['Press enter to confirm or esc to cancel']]);
  });

  it('reads a request_user_input question with the description of each option', () => {
    const found = recorded('codex-question');
    expect(found.title).toBe('Question 1/1 (1 unanswered)');
    expect(found.body).toEqual(['Which color do you prefer?']);
    expect(found.options).toEqual([{label: 'Red', detail: 'Choose red.'}, {label: 'Blue', detail: 'Choose blue.'}, {label: 'None of the above', detail: 'Optionally, add details in notes (tab)'}]);
    expect(found.hint).toEqual(['tab to add notes | enter to submit answer | esc to interrupt']);
  });

  it('reads /model with the current model highlighted and every model in its place', () => {
    const found = recorded('codex-model');
    expect(found.title).toBe('Select Model and Effort');
    expect(found.options).toHaveLength(8);
    expect(found.options[7]).toEqual({label: 'GPT-5.6-Luna (current)', detail: 'Older fast and efficient model.'});
    expect(found.highlighted).toBe(7);
  });

  it('joins a description that wraps under its label, in /permissions', () => {
    const found = recorded('codex-permissions');
    expect(found.title).toBe('Update Model Permissions');
    expect(found.options[0]).toEqual({label: 'Ask for approval', detail: 'Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace'});
    expect(found.options.map(option => option.label)).toEqual(['Ask for approval', 'Approve for me', 'Full Access', 'Read Only (current)']);
  });

  it('reads a phone-width /model without taking the wrapped notice above it for its title', () => {
    const found = recorded('codex-model-narrow');
    expect(found.title).toBe('Select Model and Effort');
    expect(found.body).toEqual([]);
    expect(found.options.map(option => option.label)[0]).toBe('GPT-6.1-Sol (current)');
    expect(found.options).toHaveLength(8);
  });

  it('reads the rate-limit reminder, whose first row is a plain prompt line', () => {
    const found = recorded('codex-rate-limit');
    expect(found.title).toBe('Approaching rate limits');
    expect(found.body).toEqual(['Switch to gpt-6-luna for lower credit usage?']);
    expect(found.options.map(option => option.label)).toEqual(['Switch to gpt-6-luna', 'Keep current model', 'Keep current model (never show again)']);
  });

  it('follows the highlight as it moves and keeps the identity of the dialog', () => {
    const before = recorded('codex-approval');
    const moved = dialogScreen('codex-approval').map(row => row.replace('› 1. Yes', '  1. Yes').replace('  3. No,', '› 3. No,'));
    const after = dialog(moved);
    expect([before.highlighted, after.highlighted]).toEqual([0, 2]);
    expect(after.signature).toBe(before.signature);
  });
});

describe('liftCodexDialog fails closed', () => {
  const approval = () => dialogScreen('codex-approval');
  it('finds no dialog on the idle prompt, and never reads another screen with keys of its own (the /resume search, a Claude Code list) as one', () => {
    expect(liftCodexDialog(dialogScreen('codex-idle')).kind).toBe('none');
    for (const name of ['codex-resume', 'model', 'trust', 'rewind-list']) expect(liftCodexDialog(dialogScreen(name)).kind, name).toBe('unliftable');
  });
  it('does not guess when two rows are highlighted, none is, or the numbers do not run from 1', () => {
    expect(liftCodexDialog(approval().map(row => row.replace('  3. No,', '› 3. No,'))).kind).toBe('unliftable');
    expect(liftCodexDialog(approval().map(row => row.replace('› 1. Yes', '  1. Yes'))).kind).toBe('unliftable');
    expect(liftCodexDialog(approval().filter(row => !row.includes('1. Yes, proceed')).map(row => row.replace('  2. Yes', '› 2. Yes'))).kind).toBe('unliftable');
  });
  it('does not guess when something else sits among the options or a single option is left', () => {
    expect(liftCodexDialog(approval().map(row => row.replace('  2. Yes', 'a note: Yes'))).kind).toBe('unliftable');
    expect(liftCodexDialog(approval().filter(row => !/^\s*[23]\. /.test(row))).kind).toBe('unliftable');
  });
  it('is not a dialog once the footer has output under it', () => {
    expect(liftCodexDialog([...approval(), 'more output', 'and more', 'and more']).kind).toBe('none');
  });
});
