// Production build of the web app: Bun transpiles the TypeScript and bundles it (the type check is `tsc -b` in `bun run check`, never here).
// Vite stays the dev server and the Vitest/Playwright runtime; both resolve the same sources and the same two source-revision constants.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeTerminalDefines, sourceDefines } from './sourceRevision';

const root = resolve(import.meta.dir, '..');
const dist = resolve(process.env.LAZYSH_BUILD_OUT_DIR ?? resolve(root, 'dist'));
const stage = resolve(root, 'node_modules/.cache/bun-build');

// Vite's `?raw` suffix imports a file's text.
const rawText: Bun.BunPlugin = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, ({ path, importer }) => ({
      path: Bun.resolveSync(path.slice(0, -'?raw'.length), resolve(importer, '..')),
      namespace: 'raw-text',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async ({ path }) => ({
      contents: `export default ${JSON.stringify(await readFile(path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};

// WebKit before 16.4 (the app's iOS 16.0 floor) rejects a regex literal with a lookbehind while parsing the whole chunk, which would leave the app
// blank; Vite's esbuild target turned them into `new RegExp(...)`, which only fails when that regex runs. Do the same for dependency sources.
const lookbehindLiterals: Bun.BunPlugin = {
  name: 'regex-lookbehind-literals',
  setup(build) {
    const pattern = String.raw`(?:[^\/\n\\\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])`;
    const literal = new RegExp(String.raw`(?<=[=(,:\[!&|?{};]\s*)/(${pattern}*\(\?<[=!]${pattern}*)/([dgimsuvy]*)`, 'g');
    build.onLoad({ filter: /\/node_modules\/.*\.[cm]?js$/ }, async ({ path }) => {
      const text = await readFile(path, 'utf8');
      if (!text.includes('(?<')) return undefined;
      return { contents: text.replace(literal, (_match, source, flags) => `new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)})`), loader: 'js' };
    });
  },
};

// Bun resolves a page's root-relative URLs against the page's directory; Vite serves them from the project root, falling back to public/.
async function stagedPage(): Promise<string> {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const html = (await readFile(resolve(root, 'index.html'), 'utf8')).replace(/(\s(?:src|href)=")\/([^"]+)(")/g, (_m, open, url, close) =>
    `${open}${existsSync(resolve(root, 'public', url)) ? '../../../public/' : '../../../'}${url}${close}`);
  const page = resolve(stage, 'index.html');
  await writeFile(page, html);
  return page;
}

const result = await Bun.build({
  entrypoints: [await stagedPage()],
  outdir: dist,
  target: 'browser',
  minify: true,
  splitting: true,
  publicPath: '/',
  naming: { entry: '[name].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
  define: {
    ...sourceDefines(),
    ...nativeTerminalDefines(),
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.MODE': '"production"',
    'import.meta.env.VITE_LAZYSH_QR_CAMERA_TRACE': process.env.VITE_LAZYSH_QR_CAMERA_TRACE === undefined ? 'undefined' : JSON.stringify(process.env.VITE_LAZYSH_QR_CAMERA_TRACE),
  },
  plugins: [rawText, lookbehindLiterals],
});
await rm(stage, { recursive: true, force: true });
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
if (existsSync(resolve(root, 'public'))) await cp(resolve(root, 'public'), dist, { recursive: true, force: false });
console.log(`built ${result.outputs.length} files into ${dist}`);
