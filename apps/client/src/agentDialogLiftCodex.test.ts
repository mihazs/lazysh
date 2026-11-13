import {describe, expect, it} from 'vitest';
import {liftCodexDialog} from './agentDialogLiftCodex';
import {dialogScreen, onTmux} from './test/agentDialogScreens';

/** Screens captured from Codex 0.167.0 in a real 100x40 tmux pane, cut to the rows from the history above the dialog to its footer. */
const lift = (name: string, rows = dialogScreen(name)) => liftCodexDialog(rows);
const dialog = (name: string, rows?: string[]) => {const result = lift(name, rows); if (result.kind !== 'dialog') throw new Error(`${name}: ${result.kind}`); return result.dialog;};

describe('liftCodexDialog on recorded Codex screens', () => {
  it('reads the /model picker: label, description and the row Codex highlights', () => {
    const found = dialog('codex-model');
    expect(found.title).toBe('Select Model and Effort');
    expect(found.options.map(option => option.label)).toEqual(['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6.1 Terra (current)', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna']);
    expect(found.options[2].detail).toBe('GPT-6.1 Terra Codex model.');
    expect(found.highlighted).toBe(2);
    expect(found.hint).toEqual(['enter select · esc back']);
  });

  it('joins a description that wraps under its option', () => {
    const found = dialog('codex-permissions');
    expect(found.title).toBe('Update Model Permissions');
    expect(found.options.map(option => option.label)).toEqual(['Ask for approval', 'Approve for me', 'Full Access', 'Read Only (current)']);
    expect(found.options[0].detail).toBe('Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace');
    expect(found.highlighted).toBe(3);
  });

  it('reads the review preset list, whose options have no description', () => {
    const found = dialog('codex-review');
    expect(found.options.map(option => option.label)).toEqual(['Review against a base branch', 'Review uncommitted changes', 'Review a commit', 'Custom review instructions']);
    expect(found.options[0].detail).toBe('(PR Style)');
    expect(found.highlighted).toBe(0);
  });

  it('reads the reasoning-level page and its different footer', () => {
    const found = dialog('codex-effort');
    expect(found.title).toBe('Select Reasoning Level for GPT-6.1 Terra');
    expect(found.options).toHaveLength(5);
    expect(found.highlighted).toBe(1);
    expect(found.hint).toEqual(['enter default · s session · esc back']);
  });

  it('reads an approval prompt with the command it asks about, and follows the highlight as it moves', () => {
    const before = dialog('codex-approval');
    const after = dialog('codex-approval', dialogScreen('codex-approval').map(row => row.replace('› 1.', '  1.').replace('  2. Yes', '› 2. Yes')));
    expect(before.title).toBe('Would you like to run the following command?');
    expect(before.body).toEqual(['Environment: local', 'Reason: May I create note.txt as requested?', '$ touch note.txt']);
    expect(before.options.map(option => option.label)).toEqual(['Yes, proceed (y)', "Yes, and don't ask again for commands that start with `touch note.txt` (p)", 'No, and tell Codex what to do differently (esc)']);
    expect([before.highlighted, after.highlighted]).toEqual([0, 1]);
    expect(after.signature).toBe(before.signature);
    // The option that adds a permission rule says so; the others do not.
    expect(before.options.map(option => option.remember === true)).toEqual([false, true, false]);
    expect(before.hint).toEqual(['Press enter to confirm or esc to cancel']);
  });

  it('reads the dialog under the history that the agent printed above it, and under a tmux status row', () => {
    const found = dialog('codex-ratelimit', onTmux(dialogScreen('codex-ratelimit')));
    expect(found.title).toBe('Approaching rate limits');
    expect(found.body).toEqual(['Switch to gpt-6-luna for lower credit usage?']);
    expect(found.options.map(option => option.label)).toEqual(['Switch to gpt-6-luna', 'Keep current model', 'Keep current model (never show again)']);
    expect(found.options[0].detail).toBe('Fast and affordable model for easier tasks.');
  });

  it('shows nothing for the idle composer, and refuses a footer it was not captured with', () => {
    expect(lift('codex-idle').kind).toBe('none');
    // The /resume table is a full-screen dialog of its own: the caller points to the terminal.
    expect(lift('codex-resume').kind).toBe('unliftable');
  });

  it('refuses a list that is not numbered from 1, has no highlighted row or has two', () => {
    const rows = dialogScreen('codex-approval');
    expect(lift('x', rows.map(row => row.replace('› 1. Yes', '  1. Yes'))).kind).toBe('unliftable');
    expect(lift('x', rows.map(row => row.replace('  2. Yes', '› 2. Yes'))).kind).toBe('unliftable');
    expect(lift('x', rows.map(row => row.replace('  3. No', '  4. No'))).kind).toBe('unliftable');
  });
});
