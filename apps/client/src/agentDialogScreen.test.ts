import {describe, expect, it} from 'vitest';
import {copyLimits, dialogCopy} from './agentDialogScreen';
import {dialogScreen, onTmux} from './test/agentDialogScreens';

/** A recorded screen as a multiplexer draws it, with its status row below. */
const screen = (name: string) => onTmux(dialogScreen(name).slice(0, 39));
const lines = (text: string) => text.split('\n');

describe('dialogCopy of the dialogs no profile can read exactly', () => {
  it.each([
    ['config', 'Settings  Status   Config   Usage   Stats', 'Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear'],
    ['permissions-tabs', 'Permissions  Recently blocked   Allow   Ask   Deny   Auto mode   Workspace', '←/→ to switch · ↓ to select · Esc to cancel'],
    ['login', 'Login', 'Esc to cancel'],
    ['hooks', 'Hooks', 'Enter to view · Esc to close'],
  ])('copies the Claude Code %s dialog from under its frame to its footer, without the status row below', (name, first, last) => {
    const copy = lines(dialogCopy('Claude Code', screen(name)));
    expect([copy[0], copy.at(-1)]).toEqual([first, last]);
    expect(copy.join('\n')).not.toMatch(/\[work\]|^─{20,}$/m);
  });

  it('finds the frame Claude Code 2.1.326 draws, also with a tip drawn over it, and the footer wrapped over two rows', () => {
    const rows = screen('permissions-tabs');
    const frames = ['▔'.repeat(100), " tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus trac… ▔"];
    for (const frame of frames) {
      const copy = lines(dialogCopy('Claude Code', rows.map(row => /^─+$/.test(row) ? frame : row)));
      expect([copy[0], copy.at(-1)]).toEqual(['Permissions  Recently blocked   Allow   Ask   Deny   Auto mode   Workspace', '←/→ to switch · ↓ to select · Esc to cancel']);
    }
    const wrapped = rows.flatMap(row => row.endsWith('Esc to cancel') ? [row.replace(' cancel', ''), 'cancel'] : [row]);
    const copy = lines(dialogCopy('Claude Code', wrapped));
    expect(copy.slice(-2).map(row => row.trim())).toEqual(['←/→ to switch · ↓ to select · Esc to', 'cancel']);
  });

  it('copies Codex\'s full-screen /resume table from its first row, and an inline dialog from the text above its options', () => {
    const table = lines(dialogCopy('Codex', screen('codex-resume')));
    expect([table[0], table.at(-1)?.trim()]).toEqual(['Resume a previous session', 'enter resume   esc exit   ^c exit   tab focus   ←/→ option']);
    expect(table.join('\n')).toContain('No sessions yet');
    const inline = lines(dialogCopy('Codex', screen('codex-permissions')));
    expect([inline[0], inline.at(-1)?.trim()]).toEqual(['Update Model Permissions', 'enter select · esc back']);
    expect(inline.join('\n')).not.toContain('›  ');
  });

  it('copies nothing without a footer: an idle screen, a working agent\'s status row, an unframed footer', () => {
    expect(dialogCopy('Claude Code', screen('idle'))).toBe('');
    expect(dialogCopy('Codex', screen('codex-idle'))).toBe('');
    expect(dialogCopy('Claude Code', ['● Reading the files…', '', '  esc to interrupt'])).toBe('');
    expect(dialogCopy('Claude Code', ['output', 'more output', '  Enter to select · Esc to cancel'])).toBe('');
  });

  it('bounds what it copies', () => {
    const long = ['─'.repeat(100), ...Array.from({length: 100}, (_, index) => `   row ${index} ${'x'.repeat(400)}`), '  Esc to cancel'];
    expect(dialogCopy('Claude Code', long)).toBe('');
    const tall = ['─'.repeat(100), ...Array.from({length: 38}, (_, index) => `   row ${index} ${'x'.repeat(400)}`), '  Esc to cancel'];
    const copy = lines(dialogCopy('Claude Code', tall));
    expect(copy.length).toBeLessThanOrEqual(copyLimits.rows);
    expect(Math.max(...copy.map(row => row.length))).toBeLessThanOrEqual(copyLimits.text);
  });
});
