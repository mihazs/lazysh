// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import RepositoryPanel, { diffLines, parseRepositoryStatus } from './RepositoryPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./bridge', () => ({ api: { readFile: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear(); });
const hash = 'a'.repeat(40);

it('pairs hunk deletions and insertions without losing line numbers', () => {
  expect(diffLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n\\ No newline at end of file')).toEqual([
    { kind: 'hunk', left: '@@ -2,2 +2,3 @@' },
    { kind: 'context', before: 2, after: 2, left: 'same', right: 'same' },
    { kind: 'change', before: 3, after: 3, left: 'old', right: 'new' },
    { kind: 'change', before: undefined, after: 4, left: undefined, right: 'extra' },
  ]);
});

it('rejects malformed host status responses', () => {
  expect(parseRepositoryStatus({ path: '/repo', changes: [] })).toEqual({ path: '/repo', changes: [] });
  for (const value of [null, { path: '/repo', changes: [{ path: 'file', index: 'evil', worktree: 'M', originalPath: null }] }, { path: '/repo', changes: Array(10001).fill({}) }]) expect(() => parseRepositoryStatus(value)).toThrow();
});

it('uses canonical root for untracked reads and reviews binary changes explicitly', async () => {
  const { api } = await import('./bridge');
  vi.mocked(api.readFile).mockResolvedValue('untracked content');
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'repository_status') return { path: '/root/repo', changes: [{ path: 'new.txt', index: '?', worktree: '?', originalPath: null }, { path: 'binary.dat', index: ' ', worktree: 'M', originalPath: null }] };
    if (command === 'repository_history') return [{ oid: hash, subject: 'initial' }];
    if (command === 'repository_diff') return { binary: true, patch: 'Binary files differ' };
    throw new Error(String(command));
  });
  render(<RepositoryPanel sessionId="ssh1" />);
  fireEvent.change(screen.getByLabelText('Repository directory'), { target: { value: '/root/repo/subdir' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
  await screen.findByText(/Untracked file/);
  fireEvent.click(screen.getAllByRole('button', { name: 'Read file' })[0]);
  expect(await screen.findByText('untracked content')).toBeTruthy();
  expect(api.readFile).toHaveBeenCalledWith('ssh1', '/root/repo/new.txt');
  fireEvent.click(screen.getByRole('button', { name: 'Unstaged diff' }));
  expect(await screen.findByText('Binary file changed. Text diff unavailable.')).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith('repository_diff', { sessionId: 'ssh1', path: '/root/repo', filePath: 'binary.dat', staged: false }, { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it('renders historical Markdown without active HTML or remote image requests', async () => {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'repository_status') return { path: '/repo', changes: [] };
    if (command === 'repository_history') return [{ oid: hash, subject: 'initial' }];
    if (command === 'repository_tree') return [{ path: 'README.md', oid: hash, kind: 'blob', size: 90 }];
    if (command === 'repository_blob') return { text: '# Safe\n![tracking](https://evil.example/image) <script>bad()</script>', binary: false, bytes: 90 };
    throw new Error(String(command));
  });
  const { container } = render(<RepositoryPanel sessionId="ssh1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
  await screen.findByRole('option', { name: /initial/ });
  fireEvent.change(screen.getByLabelText('Repository revision'), { target: { value: hash } });
  fireEvent.click(await screen.findByRole('button', { name: /README.md/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Render Markdown' }));
  expect(await screen.findByRole('heading', { name: 'Safe' })).toBeTruthy();
  expect(container.querySelector('img, script, iframe')).toBeNull();
  expect(screen.getByText('[Remote image omitted]')).toBeTruthy();
});

it('stages editable line comments without sending them to the remote shell', async () => {
  const { api } = await import('./bridge');
  vi.mocked(api.readFile).mockResolvedValue('first\nsecond');
  vi.mocked(invoke).mockImplementation(async command => command === 'repository_status' ? { path: '/repo', changes: [{ path: 'new.txt', index: '?', worktree: '?', originalPath: null }] } : [{ oid: hash, subject: 'initial' }]);
  const staged = vi.fn();
  window.addEventListener('lazysh-prompt-draft', staged);
  render(<RepositoryPanel sessionId="ssh1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Read file' }));
  fireEvent.change(await screen.findByLabelText('Comment line'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add line comment' }));
  fireEvent.change(screen.getByRole('textbox', { name: /new.txt:2/ }), { target: { value: 'Please explain this line.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use in next prompt' }));
  expect(staged).toHaveBeenCalledOnce();
  expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'ssh1', text: '/repo/new.txt:2 (working tree)\nPlease explain this line.' });
  expect(invoke).not.toHaveBeenCalledWith('write_stdin', expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(JSON.parse(sessionStorage.getItem('lazysh-review:ssh1')!)).toMatchObject({ path: '/repo', file: 'new.txt' });
  window.removeEventListener('lazysh-prompt-draft', staged);
});

it('restores remembered selection and renders image bytes through a local data URL', async () => {
  sessionStorage.setItem('lazysh-review:ssh1', JSON.stringify({ path: '/repo', revision: hash, file: 'image.png' }));
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'repository_status') return { path: '/repo', changes: [] };
    if (command === 'repository_history') return [{ oid: hash, subject: 'initial' }];
    if (command === 'repository_tree') return [{ path: 'image.png', oid: hash, kind: 'blob', size: 8 }];
    if (command === 'repository_image') return { mime: 'image/png', data: [137, 80, 78, 71, 13, 10, 26, 10] };
    throw new Error(String(command));
  });
  render(<RepositoryPanel sessionId="ssh1" />);
  const image = await screen.findByRole('img', { name: 'Preview of image.png' });
  expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(invoke).toHaveBeenCalledWith('repository_image', { sessionId: 'ssh1', path: '/repo', filePath: 'image.png', objectId: hash }, { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it('pages stable history and browses directories without loading the complete repository tree', async () => {
  const commits = Array.from({ length: 50 }, (_, i) => ({ oid: i.toString(16).padStart(40, '0'), subject: `commit ${i}` }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'repository_status') return { path: '/repo', changes: [] };
    if (command === 'repository_history') return args && 'offset' in args ? [] : commits;
    if (command === 'repository_tree') return args && 'directory' in args && args.directory === 'src' ? [{ path: 'src/app.ts', oid: hash, kind: 'blob', size: 10 }] : [{ path: 'src', oid: hash, kind: 'tree', size: null }];
    throw new Error(String(command));
  });
  render(<RepositoryPanel sessionId="ssh1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open repository' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Load older commits' }));
  expect(invoke).toHaveBeenLastCalledWith('repository_history', { sessionId: 'ssh1', path: '/repo', offset: 50, revision: commits[0].oid }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  await screen.findByRole('option', { name: /commit 0$/ });
  fireEvent.change(screen.getByLabelText('Repository revision'), { target: { value: commits[0].oid } });
  fireEvent.click(await screen.findByRole('button', { name: /^src\s*tree$/ }));
  expect(await screen.findByRole('button', { name: /src\/app.ts/ })).toBeTruthy();
  expect(invoke).toHaveBeenLastCalledWith('repository_tree', { sessionId: 'ssh1', path: '/repo', revision: commits[0].oid, directory: 'src' }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(screen.getByRole('button', { name: 'Parent directory' })).toBeTruthy();
});
