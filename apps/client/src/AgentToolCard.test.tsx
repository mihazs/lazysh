// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import AgentToolCard from './AgentToolCard';

afterEach(() => {cleanup(); vi.restoreAllMocks();});
const bash = (command: string) => ({name: 'Bash', text: JSON.stringify({command})});
const output = Array.from({length: 30}, (_, index) => `line ${index + 1}`).join('\n');

describe('AgentToolCard', () => {
  it('shows a failing command with its summary, exit code and output tail, and Show all reveals the rest', () => {
    render(<AgentToolCard use={bash('cargo test')} result={{text: `Exit code 101\n${output}`, isError: true}} live={false} />);
    const card = screen.getByText('Bash').closest('details')!;
    expect(card.getAttribute('data-status')).toBe('error');
    expect(card.textContent).toContain('cargo test');
    expect(within(card).getByText(/Failed/).textContent).toContain('exit code 101');
    const tail = within(card).getByLabelText('Output');
    expect(tail.textContent?.split('\n')).toHaveLength(20);
    expect(tail.textContent).toContain('line 30');
    expect(tail.textContent).not.toContain('line 1\n');
    fireEvent.click(within(card).getByRole('button', {name: 'Show 10 earlier lines'}));
    expect(within(card).getByLabelText('Output').textContent).toContain('line 1\n');
    expect(within(card).queryByRole('button', {name: /earlier lines/})).toBeNull();
  });
  it('copies the full output, not only the tail', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    render(<AgentToolCard use={bash('seq 30')} result={{text: output}} live={false} />);
    fireEvent.click(screen.getByRole('button', {name: 'Copy output'}));
    await screen.findByText('Copied');
    expect(writeText).toHaveBeenCalledWith(output);
  });
  it('is running only while the agent works, shows nothing for a call that will never return, and marks a refusal as declined', () => {
    const {rerender} = render(<AgentToolCard use={bash('sleep 9')} live />);
    expect(screen.getByText(/Running/)).toBeTruthy();
    rerender(<AgentToolCard use={bash('sleep 9')} live={false} />);
    expect(screen.queryByText(/Running/)).toBeNull();
    rerender(<AgentToolCard use={bash('rm -rf x')} result={{text: "The user doesn't want to proceed with this tool use.", isError: true}} live={false} />);
    expect(screen.getByText('Declined')).toBeTruthy();
  });
  it('draws an edit as a diff card with counts, wraps and copies the diff', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    render(<AgentToolCard use={{name: 'Edit', text: JSON.stringify({file_path: 'src/a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;'})}} result={{text: 'The file has been updated.'}} live={false} />);
    const card = screen.getByText('Edit').closest('details')!;
    expect(card.getAttribute('data-kind')).toBe('diff');
    expect(within(card).getByLabelText('2 lines added, 1 removed')).toBeTruthy();
    expect(card.querySelector('.agent-diff-lines')!.textContent).toBe(' const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n');
    expect(card.querySelector('.agent-diff-lines')!.getAttribute('data-wrap')).toBe('true');
    fireEvent.click(within(card).getByRole('button', {name: 'Wrap lines'}));
    expect(card.querySelector('.agent-diff-lines')!.getAttribute('data-wrap')).toBe('false');
    fireEvent.click(within(card).getByRole('button', {name: 'Copy diff'}));
    await screen.findByText('Copied');
    expect(writeText).toHaveBeenCalledWith('src/a.ts\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;');
  });
  it('shows a Read with its range and an unknown tool with its raw input', () => {
    render(<><AgentToolCard use={{name: 'Read', text: JSON.stringify({file_path: '/r/a.ts', offset: 5, limit: 10})}} result={{text: 'x'}} live={false} />
      <AgentToolCard use={{name: 'mcp__x__y', text: JSON.stringify({id: 7})}} live={false} /></>);
    expect(screen.getByText('/r/a.ts:5-14')).toBeTruthy();
    expect(screen.getByText('mcp__x__y')).toBeTruthy();
  });
});
