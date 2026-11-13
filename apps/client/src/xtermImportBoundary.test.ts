import {describe, expect, it} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const client = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipped = new Set(['node_modules', 'test-results', 'dist', 'src-tauri', 'native-e2e', 'published-native-e2e']);
const options = ts.parseJsonConfigFileContent(ts.readConfigFile(join(client, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, client).options;

function sources(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (skipped.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every project file with a static or dynamic import, type-only imports and `export ... from` included, that the module resolver sends to an `@xterm/*` package. */
function xtermImporters() {
  const importers = new Map<string, string[]>();
  for (const file of ['src', 'e2e', 'bench'].flatMap(directory => sources(join(client, directory)))) {
    const found = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.map(({fileName}) => fileName);
    const reached = found.filter(specifier => {
      if (specifier.startsWith('.')) return false;
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
      // Style sheets and JSON are not resolved as TypeScript modules; their package name still gives them away.
      return resolved ? resolved.includes(`${sep}node_modules${sep}@xterm${sep}`) : specifier.startsWith('@xterm/');
    });
    if (reached.length) importers.set(relative(client, file).split(sep).join('/'), [...new Set(reached)].sort());
  }
  return importers;
}

/**
 * The migration to the TerminalAdapter ends with only the xterm backend importing xterm.js (docs/architecture/terminal-migration-plan.md).
 * Until the remaining seams move into it, this list may only shrink: a new importer outside it fails the build.
 */
const backend = [
  'src/moshResize.ts', 'src/terminal.ts', 'src/terminalBackends.ts', 'src/terminalBold.ts', 'src/terminalFit.ts', 'src/terminalIme.ts',
  'src/terminalLinks.ts', 'src/xterm/selection.ts', 'src/xtermOptions.ts', 'src/xtermTerminalAdapter.ts',
];
/** Entry points that still draw xterm directly; each is a migration step with its own issue (#1308). */
const pending = ['src/TerminalPane.tsx'];
/** Tests and harnesses of the xterm backend itself. */
const backendTests = [
  'e2e/fixtures/TerminalImeHarness.ts', 'e2e/fixtures/ThemeRenderingHarness.ts', 'e2e/mosh-resize.spec.ts', 'src/terminalBold.test.ts', 'src/terminalLinks.test.ts', 'src/xtermTerminalAdapter.test.ts',
];

describe('who imports xterm.js', () => {
  it('is the xterm backend and the entry points still to migrate, and nothing else', () => {
    expect([...xtermImporters().keys()].sort()).toEqual([...backend, ...pending, ...backendTests].sort());
  });

  it('keeps every consumer of the terminal behind the adapter', () => {
    const importers = xtermImporters();
    for (const consumer of ['src/App.tsx', 'src/TerminalSelectionTools.tsx', 'src/herdrNavigationCells.ts', 'src/terminalTouchSelection.ts', 'src/preferences.ts', 'src/themeImport.ts'])
      expect(importers.has(consumer), consumer).toBe(false);
  });
});
