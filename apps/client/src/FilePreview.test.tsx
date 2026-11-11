// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {FilesPanel} from './SessionTools';

vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn()}));
vi.mock('./bridge', () => ({api: {listDirectory: vi.fn(), readFile: vi.fn(), hostFileStat: vi.fn(async () => { throw new Error('transfer actions are not under test'); })}}));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="window.svgRan=1"><script>window.svgRan=1</script><rect width="4" height="4"/></svg>';
const markdown = '# Release notes\n\n<img src=x onerror="window.markdownRan=1"><script>window.markdownRan=1</script>\n\n[active](javascript:alert(1)) ![remote](https://example.invalid/a.png)';
const blobs: Blob[] = [];
beforeEach(async () => {
  const {api} = await import('./bridge');
  vi.mocked(api.listDirectory).mockResolvedValue([
    {name: 'logo.png', isDir: false, size: 8}, {name: 'huge.webp', isDir: false, size: 2 * 1024 * 1024 + 1},
    {name: 'icon.svg', isDir: false, size: svg.length}, {name: 'README.md', isDir: false, size: markdown.length},
  ]);
  vi.mocked(api.readFile).mockImplementation(async (_session, path) => path.endsWith('.svg') ? svg : markdown);
  vi.mocked(invoke).mockResolvedValue({mime: 'image/png', data: [137, 80, 78, 71, 13, 10, 26, 10]});
  URL.createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:svg-${blobs.length}`; });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); blobs.length = 0; });
const open = async (name: string) => fireEvent.click(await screen.findByRole('button', {name: new RegExp(name.replace('.', '\\.'))}));

it('reads raster images through the sniffing native reader and refuses oversize ones before reading', async () => {
  render(<FilesPanel sessionId="ssh1"/>);
  await open('logo.png');
  const image = await screen.findByRole('img', {name: 'Preview of ./logo.png'});
  expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(invoke).toHaveBeenCalledWith('repository_image', {sessionId: 'ssh1', path: '.', filePath: 'logo.png', objectId: null}, expect.anything());
  vi.mocked(invoke).mockClear();
  await open('huge.webp');
  expect((await screen.findByRole('alert')).textContent).toBe('Image previews are limited to 2 MiB. Open larger files in the terminal.');
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce({mime: 'image/svg+xml', data: [60]});
  await open('logo.png');
  expect((await screen.findByRole('alert')).textContent).toBe('Invalid repository response. Update the client and reconnect.');
});

it('shows SVG only as an image resource and offers its escaped source', async () => {
  const {container} = render(<FilesPanel sessionId="ssh1"/>);
  await open('icon.svg');
  const image = await screen.findByRole('img', {name: 'Preview of ./icon.svg'});
  expect(image.getAttribute('src')).toBe('blob:svg-1');
  expect(blobs[0].type).toBe('image/svg+xml');
  expect(container.querySelector('.file-preview svg, .file-preview script')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Show source'}));
  expect(container.querySelector('.file-preview pre')?.textContent).toBe(svg);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:svg-1');
  fireEvent.click(screen.getByRole('button', {name: 'Show image'}));
  expect((await screen.findByRole('img', {name: 'Preview of ./icon.svg'})).getAttribute('src')).toBe('blob:svg-2');
  expect(Reflect.get(window, 'svgRan')).toBeUndefined();
});

it('renders Markdown without raw HTML, active links or remote images', async () => {
  const {container} = render(<FilesPanel sessionId="ssh1"/>);
  await open('README.md');
  const preview = container.querySelector<HTMLElement>('.file-preview')!;
  expect((await within(preview).findByRole('heading', {level: 1})).textContent).toBe('Release notes');
  expect(preview.querySelector('img, script, a')).toBeNull();
  expect(within(preview).getByText('active')).toBeTruthy();
  expect(within(preview).getByText('[Remote image omitted]')).toBeTruthy();
  expect(Reflect.get(window, 'markdownRan')).toBeUndefined();
  fireEvent.click(screen.getByRole('button', {name: 'Show source'}));
  expect(preview.querySelector('pre')?.textContent).toBe(markdown);
  expect(screen.getByRole('button', {name: 'Render Markdown'})).toBeTruthy();
});
