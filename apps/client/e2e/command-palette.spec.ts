import {workspaceControl} from './fixtures/workspaceControl';
import {installNativeBridge} from './fixtures/nativeBridge';
import {expect, test, type Page} from '@playwright/test';

declare global {interface Window {paletteFixture: {reads: string[]; images: unknown[]}; svgRan?: number; markdownRan?: number}}
const png = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" onload="window.svgRan=1"><script>window.svgRan=1</script><image href="https://example.invalid/tracker.png" width="1" height="1"/><rect width="24" height="24" fill="#3a7"/></svg>';
const markdown = '# Release notes\n\nPlain **bold** text.\n\n<img src="x" onerror="window.markdownRan=1"><script>window.markdownRan=1</script>\n\n[active link](javascript:window.markdownRan=1)';

test.beforeEach(async ({page}) => {
  await installNativeBridge(page, undefined, {nativeEvents: true});
  await page.addInitScript(({png, svg, markdown}) => {
    window.paletteFixture = {reads: [], images: []};
    window.nativeFixtureInvoke = async (command, args) => {
      if (command === 'list_hosts') return [{id: 'fixture', name: 'Fixture', hostname: 'fixture.invalid', username: 'owner', port: 22}];
      if (command === 'local_capability') return {available: false, reason: 'Synthetic command palette fixture.'};
      if (command === 'transport_capabilities') return {mosh: false, et: false};
      if (command === 'has_credentials') return false;
      if (command === 'connect') return {sessionId: 'palette-session'};
      if (command === 'list_directory') return [{name: 'docs', isDir: true, size: 0}, {name: 'README.md', isDir: false, size: markdown.length}, {name: 'icon.svg', isDir: false, size: svg.length}, {name: 'pixel.png', isDir: false, size: png.length}];
      if (command === 'read_file') { window.paletteFixture.reads.push(String(args.path)); return String(args.path).endsWith('.svg') ? svg : markdown; }
      if (command === 'repository_image') { window.paletteFixture.images.push(args); return {mime: 'image/png', data: png}; }
      if (command.startsWith('plugin:event|') || ['resize', 'ack_output', 'disconnect', 'cancel_credential_auth'].includes(command)) return;
      throw new Error(`Unexpected synthetic command palette command: ${command}`);
    };
  }, {png, svg, markdown});
});

async function connect(page: Page, phone: boolean) {
  await page.goto('/');
  if (phone) await page.getByRole('button', {name: 'Open hosts', exact: true}).click();
  await page.getByRole('button', {name: 'Connect to Fixture', exact: true}).click();
  await page.getByLabel('Password', {exact: true}).fill('synthetic-entry');
  await page.getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(page.locator('.terminal-canvas').first()).toBeAttached();
  await expect(page.getByLabel('Password', {exact: true})).toHaveCount(0);
}

test('the command palette filters and runs workspace tools, then Files views images and Markdown inertly', async ({page}, testInfo) => {
  const phone = testInfo.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
  await connect(page, phone);

  // Desktop opens it from the focused terminal, whose shell keeps Ctrl+K; a phone uses Workspace tools.
  if (phone) await (await workspaceControl(page, 'Search saved hosts')).click();
  else {
    await expect(page.locator('.terminal-canvas:visible .xterm-helper-textarea')).toBeFocused();
    await page.keyboard.press('Control+Shift+P');
  }
  const palette = page.getByRole('dialog', {name: 'Command palette', exact: true});
  const search = palette.getByRole('combobox', {name: 'Search hosts, sessions and commands', exact: true});
  await expect(search).toBeFocused();
  await expect(palette.getByRole('option', {name: /^Fixture.*Current$/})).toBeVisible();
  await search.fill('fils');
  await expect(palette.getByRole('option')).toHaveText([/^Files/]);
  await expect(search).toHaveAttribute('aria-activedescendant', (await palette.getByRole('option').first().getAttribute('id'))!);
  expect(await palette.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('palette.png')});
  if (phone) await palette.getByRole('option', {name: /^Files/}).tap();
  else await search.press('Enter');
  await expect(palette).toHaveCount(0);
  const files = page.getByRole('region', {name: 'Remote files', exact: true});
  await expect(files).toBeVisible();

  // Escape closes without running; arrows reach an action that opens its own dialog.
  if (!phone) {
    await page.locator('body').click({position: {x: 1, y: 1}});
    await page.keyboard.press('Control+k');
    await expect(search).toBeFocused();
    await search.fill('diff');
    await search.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(files).toBeVisible();
    await page.keyboard.press('Control+k');
    await search.fill('about');
    await search.press('ArrowDown');
    await search.press('ArrowUp');
    await search.press('Enter');
    await expect(page.getByRole('dialog', {name: 'About lazysh', exact: true})).toBeVisible();
    await page.keyboard.press('Escape');
  }

  await files.getByRole('button', {name: /^pixel\.png/}).click();
  const raster = files.getByRole('img', {name: 'Preview of ./pixel.png', exact: true});
  await expect(raster).toBeVisible();
  await expect.poll(() => raster.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
  expect(await page.evaluate(() => window.paletteFixture.images)).toEqual([{sessionId: 'palette-session', path: '.', filePath: 'pixel.png', objectId: null}]);

  await files.getByRole('button', {name: /^icon\.svg/}).click();
  const vector = files.getByRole('img', {name: 'Preview of ./icon.svg', exact: true});
  await expect(vector).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => vector.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(24);
  await expect(files.locator('.file-preview svg, .file-preview script, .file-preview iframe, .file-preview object')).toHaveCount(0);
  await files.getByRole('button', {name: 'Show source', exact: true}).click();
  await expect(files.locator('.file-preview pre')).toHaveText(svg);
  await page.screenshot({path: testInfo.outputPath('svg-source.png')});

  await files.getByRole('button', {name: /^README\.md/}).click();
  const preview = files.locator('.file-preview');
  await expect(preview.getByRole('heading', {level: 1, name: 'Release notes'})).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('bold');
  await expect(preview.getByText('active link', {exact: true})).toBeVisible();
  await expect(preview.locator('a, img, script')).toHaveCount(0);
  expect(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('markdown.png')});

  expect(await page.evaluate(() => [window.svgRan, window.markdownRan])).toEqual([undefined, undefined]);
  expect(await page.evaluate(() => window.paletteFixture.reads)).toEqual(['./icon.svg', './README.md']);
  expect(errors).toEqual([]);
});
