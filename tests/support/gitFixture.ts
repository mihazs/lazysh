import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Env = Record<string, string | undefined>;
export const project = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Run a command and capture its exit code and text output without throwing. */
export async function spawnText(cwd: string, argv: string[], env: Env = process.env) {
  const child = Bun.spawn(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** Track disposable fixture roots under ~/dev/.worktrees and remove them after the suite. */
export function gitFixtureRoots(prefix: string) {
  const roots: string[] = [];
  return {
    async create() {
      const parent = join(homedir(), 'dev', '.worktrees');
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(join(parent, prefix));
      roots.push(root);
      await writeFile(join(root, 'empty.gitconfig'), '');
      const env: Env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
      return { root, env };
    },
    cleanup: () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))),
  };
}
