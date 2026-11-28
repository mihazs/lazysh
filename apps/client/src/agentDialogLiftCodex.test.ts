import {describe, expect, it} from 'vitest';
import {liftCodexDialog} from './agentDialogLiftCodex';
import {codexModelWindow, dialogScreen, onTmux, runsOn} from './test/agentDialogScreens';

/** Screens captured from Codex 0.167.0 in a real 100x40 tmux pane, cut to the rows from the history above the dialog to its footer. */
const lift = (name: string, rows = dialogScreen(name)) => liftCodexDialog(rows);
const dialog = (name: string, rows?: string[]) => {const result = lift(name, rows); if (result.kind !== 'dialog') throw new Error(`${name}: ${result.kind}`); return result.dialog;};

describe('liftCodexDialog on recorded Codex screens', () => {
  it('treats a changed option description as a different dialog', () => {
    const original = dialog('codex-model');
    const changed = dialog('codex-model', dialogScreen('codex-model').map(row => row.replace('GPT-6.1 Terra Codex model.', 'Different model details.')));
    expect(changed.options.map(option => option.label)).toEqual(original.options.map(option => option.label));
    expect(changed.signature).not.toBe(original.signature);
  });
  it('reads the /model picker: label, description and the row Codex highlights', () => {
    const found = dialog('codex-model');
    expect(found.title).toBe('Select Model and Effort');
    expect(found.options.map(option => option.label)).toEqual(['GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6.1 Terra (current)', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna']);
    expect(found.options[2].detail).toBe('GPT-6.1 Terra Codex model.');
    expect(found.highlighted).toBe(2);
    expect(found.hint).toEqual(['enter select · esc back']);
  });

  it.each(['codex-approval', 'codex-model', 'codex-permissions', 'codex-review', 'codex-effort', 'codex-ratelimit', 'codex-question', 'codex-question-narrow', 'codex-question-multi', 'codex-question-last'])(
    'names the rows of the %s dialog, from its text to its footer, once on the screen', name => {
      const found = dialog(name);
      const screen = dialogScreen(name);
      expect(found.rows.length).toBeGreaterThanOrEqual(4);
      expect(found.rows[0].trim()).not.toBe('');
      expect(runsOn(screen, found.rows)).toBe(1);
      expect(runsOn(onTmux(screen), found.rows)).toBe(1);
      // Moving the highlight changes a row of the block, so the host's comparison tells the dialogs apart from the one that was read.
      expect(runsOn(screen.map(row => row.replace(/^( {0,2})› /, '$1  ')), found.rows)).toBe(0);
    });

  it('names the approval prompt from the question it asks to the footer, without the history above it', () => {
    const {rows} = dialog('codex-approval');
    expect(rows[0]).toBe('  Would you like to run the following command?');
    expect(rows.at(-1)).toBe('  Press enter to confirm or esc to cancel');
    expect(rows.join('\n')).not.toContain('Running touch note.txt');
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

  describe('a request_user_input question', () => {
    it('reads the question as the title, its place among the questions as the body, and no Cancel to offer', () => {
      const found = dialog('codex-question');
      expect(found.title).toBe('Which color?');
      expect(found.body).toEqual(['Question 1/1 (1 unanswered)']);
      expect(found.options).toEqual([{label: 'Red (Recommended)', detail: 'Choose red.'}, {label: 'Green', detail: 'Choose green.'}, {label: 'None of the above', detail: 'Optionally, add details in notes (tab)'}]);
      expect(found.highlighted).toBe(0);
      expect(found.hint).toEqual([]);
      // Esc interrupts the turn in this dialog, so the card must not offer it as a way out.
      expect(found.interrupts).toBe(true);
      expect(dialog('codex-approval').interrupts).toBeUndefined();
    });

    it('follows the highlight as the arrow keys move it, under a tmux status row', () => {
      const rows = dialogScreen('codex-question');
      const moved = dialog('codex-question', onTmux(rows.map(row => row.replace('› 1.', '  1.').replace('  2. Green', '› 2. Green'))));
      expect(moved.highlighted).toBe(1);
      expect(moved.signature).toBe(dialog('codex-question').signature);
    });

    it('tells the questions of one dialog apart, and reads the footer that submits them all', () => {
      const [first, last] = [dialog('codex-question-multi'), dialog('codex-question-last')];
      expect([first.title, first.body]).toEqual(['Which color?', ['Question 1/2 (2 unanswered)']]);
      expect([last.title, last.body]).toEqual(['Which size?', ['Question 2/2 (1 unanswered)']]);
      expect(last.options.map(option => option.label)).toEqual(['Small (Recommended)', 'Large', 'None of the above']);
      expect(first.signature).not.toBe(last.signature);
    });

    it('reads a phone-width screen, where the question, both columns of an option and the footer all wrap', () => {
      const found = dialog('codex-question-narrow');
      expect(found.options[0]).toEqual({label: 'PostgreSQL 16 (Recommended)', detail: 'Use PostgreSQL 16 with logical replication enabled for the migration on the staging cluster tonight.'});
      expect(found.title).toBe('Which database should the long running migration use for the staging cluster tonight?');
      expect(found.options.map(option => option.label)).toEqual(['PostgreSQL 16 (Recommended)', 'SQLite', 'None of the above']);
      expect(found.options[1].detail).toBe('Use SQLite for a tiny local file as the database for the migration on the staging cluster tonight.');
      expect(found.highlighted).toBe(0);
    });

    it('does not read the notes box, a footer that is cut off or one it was not captured with', () => {
      // The notes box is a text field: the terminal has it.
      expect(lift('codex-question-notes').kind).toBe('unliftable');
      const rows = dialogScreen('codex-question');
      expect(lift('x', rows.map(row => row.replace('| esc to interrupt', '| esc to'))).kind).toBe('unliftable');
      expect(lift('x', rows.map(row => row.replace('submit answer', 'submit anything'))).kind).toBe('unliftable');
      // A narrow terminal may break the footer anywhere: it is still the footer, read whole, and nothing short of the whole is a question.
      const wrapped = rows.flatMap(row => row.startsWith('  tab to add notes') ? ['  tab to add notes | enter to', '  submit answer | esc to', '  interrupt'] : [row]);
      expect(lift('x', wrapped).kind).toBe('dialog');
      expect(lift('x', wrapped.filter(Boolean).slice(0, -1)).kind).toBe('unliftable');
      // Two footer rows below the last row of the footer are no status row.
      expect(lift('x', [...rows, '  one', '  two', '  three']).kind).toBe('unliftable');
    });

    it('refuses a question whose first row does not count the questions, or that has no question text', () => {
      const rows = dialogScreen('codex-question');
      expect(lift('x', rows.map(row => row.replace('Question 1/1 (1 unanswered)', 'Something else'))).kind).toBe('unliftable');
      expect(lift('x', rows.filter(row => !row.includes('Which color?'))).kind).toBe('unliftable');
    });
  });
});

/** Codex 0.172.0 has more than eight models. It shows a window of eight rows, a `↑` or `↓` row where rows are hidden above or below it, and numbers
 * only the first nine rows. `codex-0.172.0-model-scrolled` is the real screen of the last window; the other windows move over the same ten rows. */
describe('liftCodexDialog on the scrolling /model list of Codex 0.172.0', () => {
  const recorded = dialogScreen('codex-0.172.0-model-scrolled');
  const windowAt = codexModelWindow;

  it('draws the recorded window exactly as the windows built from it, so those stand for what Codex draws', () => {
    expect(windowAt(3, 10)).toEqual(recorded.slice(0, 14));
  });

  it.each([[1, 1, 0], [1, 8, 7], [2, 9, 7], [3, 9, 6], [3, 10, 7]])('reads the window from row %i with row %i highlighted, whose hidden rows stay in the terminal', (first, at, highlighted) => {
    const found = dialog('window', windowAt(first, at));
    expect(found.title).toBe('Select Model and Effort');
    expect(found.options.map(option => option.label)).toEqual(['GPT-6.2-Sol (current)', 'GPT-6.2-Astra', 'GPT-6.1 Terra', 'GPT-6.1-Sol', 'GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna',
      'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna'].slice(first - 1, first + 7));
    expect(found.highlighted).toBe(highlighted);
    expect(found.more).toBe(true);
    expect(found.hint).toEqual(['enter select · esc back']);
    // The rows the host compares the pane with include the arrow rows, so a window that scrolled is another dialog.
    expect(runsOn(windowAt(first, at), found.rows)).toBe(1);
    expect(runsOn(windowAt(first, at === 1 ? 2 : 1), found.rows)).toBe(0);
  });

  it('reads the row without a number as the row after the ninth, and reads the same list under tmux', () => {
    const found = dialog('recorded', recorded);
    expect(found.options.at(-1)).toEqual({label: 'GPT-5.6-Luna', detail: 'Legacy fast model for simpler tasks.'});
    expect(found.options[0].detail).toBe('Efficient model that excels at visual understanding and computer use.');
    expect(liftCodexDialog(onTmux(recorded.slice(0, 14)))).toEqual(lift('recorded', recorded));
  });

  it('refuses a list whose numbers do not follow each other, and rows without a number before the ninth', () => {
    expect(lift('skips', windowAt(1, 1).map(row => row.replace('  4. GPT-6.1-Sol  ', '  5. GPT-6.1-Sol  '))).kind).toBe('unliftable');
    expect(lift('no number', windowAt(1, 1).map(row => row.replace('  3. GPT-6.1 Terra', '     GPT-6.1 Terra'))).kind).toBe('unliftable');
    // Hidden rows above the list but a first row that says it is the first, or a window that starts at 3 with no arrow, is not this dialog.
    expect(lift('no arrow', windowAt(3, 4).map(row => row === '↑' ? '' : row)).kind).toBe('unliftable');
    expect(lift('two highlights', windowAt(3, 4).map(row => row.replace(/^ {2}5\./, '› 5.'))).kind).toBe('unliftable');
  });
});
