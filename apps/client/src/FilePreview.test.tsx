// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
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
    {name: 'clip.mp4', isDir: false, size: 24}, {name: 'tune.mp3', isDir: false, size: 3}, {name: 'long.webm', isDir: false, size: 8 * 1024 * 1024 + 1},
    {name: 'manual.pdf', isDir: false, size: 9},
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

const serve = (reply: unknown, playback: unknown = true) => vi.mocked(invoke).mockImplementation(async command => command === 'media_playback' ? playback : reply);
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

it('plays video and audio only in a sandboxed frame without script rights, from data of the sniffed type', async () => {
  const {container} = render(<FilesPanel sessionId="ssh1"/>);
  serve({mime: 'video/mp4', data: base64(mp4)});
  await open('clip.mp4');
  const frame = await screen.findByTitle('Preview of ./clip.mp4') as HTMLIFrameElement;
  expect(invoke).toHaveBeenCalledWith('file_media', {sessionId: 'ssh1', path: '.', fileName: 'clip.mp4', kind: 'video'}, expect.anything());
  // An empty sandbox grants no token: no script, same-origin access, form, popup or navigation of this window.
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.hasAttribute('src')).toBe(false);
  const page = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
  expect(page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toBe("default-src 'none'; media-src data:; style-src 'unsafe-inline'");
  const player = page.querySelector('video')!;
  expect(player.getAttribute('src')).toBe(`data:video/mp4;base64,${base64(mp4)}`);
  expect(player.hasAttribute('autoplay')).toBe(false);
  expect(page.querySelectorAll('script, iframe, object, embed, link, img').length).toBe(0);
  expect(container.querySelector('.file-preview video, .file-preview audio, .file-preview script')).toBeNull();
  serve({mime: 'audio/mpeg', data: base64(Uint8Array.from([73, 68, 51]))});
  await open('tune.mp3');
  const audio = await screen.findByTitle('Preview of ./tune.mp3') as HTMLIFrameElement;
  expect(invoke).toHaveBeenCalledWith('file_media', {sessionId: 'ssh1', path: '.', fileName: 'tune.mp3', kind: 'audio'}, expect.anything());
  expect(new DOMParser().parseFromString(audio.srcdoc, 'text/html').querySelector('audio')?.getAttribute('src')).toBe('data:audio/mpeg;base64,SUQz');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('refuses an oversized, mislabeled or malformed media file without showing a player', async () => {
  render(<FilesPanel sessionId="ssh1"/>);
  await open('long.webm');
  expect((await screen.findByRole('alert')).textContent).toBe('Video and audio previews are limited to 8 MiB. Use Open with or Download for larger files.');
  expect(invoke).not.toHaveBeenCalled();
  // The native reader names a file whose signature is not video or audio; the client keeps its own words.
  vi.mocked(invoke).mockRejectedValueOnce({kind: 'media_mislabeled', message: 'host text <b>ignored</b>'});
  await open('clip.mp4');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This file is not the video or audio its name says, so it was not played. Use Open with or Download to handle it yourself.'));
  vi.mocked(invoke).mockRejectedValueOnce({kind: 'media_too_large', message: 'host text'});
  await open('clip.mp4');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Video and audio previews are limited to 8 MiB. Use Open with or Download for larger files.'));
  // A response claiming a type outside the kind, or bytes that are not base64, never reaches a frame.
  for (const reply of [{mime: 'text/html', data: base64(mp4)}, {mime: 'audio/mpeg', data: base64(mp4)}, {mime: 'video/mp4', data: '<script>'}, {mime: 'video/mp4', data: [1, 2]}, null]) {
    serve(reply);
    await open('clip.mp4');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Invalid repository response. Update the client and reconnect.'));
  }
  expect(screen.queryByTitle('Preview of ./clip.mp4')).toBeNull();
  expect(document.querySelector('iframe')).toBeNull();
});

it('drops the previous file\'s player when the next file is refused', async () => {
  render(<FilesPanel sessionId="ssh1"/>);
  serve({mime: 'video/mp4', data: base64(mp4)});
  await open('clip.mp4');
  await screen.findByTitle('Preview of ./clip.mp4');
  vi.mocked(invoke).mockRejectedValueOnce({kind: 'media_mislabeled', message: 'host text'});
  await open('tune.mp3');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/^This file is not the video or audio/));
  expect(document.querySelector('iframe')).toBeNull();
});

it('makes no media element where the platform cannot play without crashing, and says why', async () => {
  render(<FilesPanel sessionId="ssh1"/>);
  serve({mime: 'video/mp4', data: base64(mp4)}, false);
  await open('clip.mp4');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/^This device cannot play video or audio inside the app\. On Linux that needs GStreamer's audio plugins/));
  expect(document.querySelector('iframe')).toBeNull();
  // Only the answer true allows it.
  serve({mime: 'video/mp4', data: base64(mp4)}, 'yes');
  await open('clip.mp4');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/cannot play video or audio/));
  expect(document.querySelector('iframe')).toBeNull();
});

it('leaves a PDF to the device viewer without reading it', async () => {
  render(<FilesPanel sessionId="ssh1"/>);
  await open('manual.pdf');
  expect((await screen.findByText(/PDF files are not drawn inside the app/)).textContent).toContain('Open with');
  expect(invoke).not.toHaveBeenCalled();
  const {api} = await import('./bridge');
  expect(api.readFile).not.toHaveBeenCalled();
});
