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
    return entry.isDirectory() ? sources(path) : /\.(?:ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
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

/** Production modules (not tests, harnesses or benches) that name xterm's private `_core`, found as identifiers in the syntax tree. */
function privateCoreUsers() {
  return sources(join(client, 'src')).map(file => relative(client, file).split(sep).join('/')).filter(file => !/\.test\.tsx?$/.test(file)).filter(file => {
    const tree = ts.createSourceFile(file, readFileSync(join(client, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let found = false;
    const visit = (node: ts.Node) => { if (ts.isIdentifier(node) && node.text === '_core') found = true; else if (!found) ts.forEachChild(node, visit); };
    visit(tree);
    return found;
  });
}

/** Standalone Node scripts that compare xterm.js with a candidate (#1323). They run outside the app, so no app code can depend on them; remove them with the baseline in #1343. */
const standaloneBenchmarks = new Set(['bench/wasmVt.mjs']);

/** The xterm backend: its adapter, option mapping and the seams that patch xterm internals. */
const isBackend = (file: string) => file.startsWith('src/xterm/') || /^src\/xterm(?:TerminalAdapter|Options)(?:\.test)?\.ts$/.test(file);

describe('who imports xterm.js', () => {
  it('is only the xterm backend, harnesses included, so no consumer can depend on xterm.js', () => {
    expect([...xtermImporters().keys()].filter(file => !isBackend(file) && !standaloneBenchmarks.has(file))).toEqual([]);
  });

  it('keeps xterm internals (`_core`) inside the backend', () => {
    expect(privateCoreUsers().filter(file => !isBackend(file))).toEqual([]);
    expect(privateCoreUsers()).toEqual(expect.arrayContaining(['src/xterm/moshResize.ts', 'src/xterm/terminalIme.ts']));
  });

  it('finds the backend through the same resolution, so the check cannot pass by finding nothing', () => {
    const inside = [...xtermImporters().keys()].filter(isBackend);
    expect(inside).toEqual(expect.arrayContaining(['src/xtermTerminalAdapter.ts', 'src/xtermOptions.ts', 'src/xterm/moshResize.ts', 'src/xterm/terminal.ts', 'src/xterm/styles.ts']));
  });

  it('keeps the pane, the selection tools, the app shell and the preferences behind the adapter', () => {
    const importers = xtermImporters();
    for (const consumer of ['src/App.tsx', 'src/TerminalPane.tsx', 'src/TerminalSelectionTools.tsx', 'src/herdrNavigationCells.ts', 'src/terminalTouchSelection.ts', 'src/terminalLinks.ts', 'src/terminal.ts', 'src/terminalBackends.ts', 'src/preferences.ts', 'src/themeImport.ts'])
      expect(importers.has(consumer), consumer).toBe(false);
  });
});
