import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
export const moonScript = join(root, 'node_modules/@moonrepo/cli/moon.js');
const memo = new Map<string, Promise<any>>();

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; } };

/**
 * Runs `task` while holding a cross-process lock for the moon workspace at `cwd`. Concurrent bun test files each
 * run moon against the same `.moon/cache`, and moon rewrites its workspace graph state there without locking, so an
 * overlapping run can read the file while it is empty. A lock whose owner process died is taken over.
 */
export async function withMoonLock<T>(task: () => Promise<T>, cwd = root, lockDir = join(tmpdir(), `lazysh-moon-${cwd.replace(/\W+/g, '_')}.lock`)): Promise<T> {
  const owner = join(lockDir, 'pid');
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lockDir); break; } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(owner, 'utf8').catch(() => 0));
      if (pid && !alive(pid)) await rm(lockDir, { recursive: true, force: true });
      else if (attempt > 6000) throw new Error(`moon lock ${lockDir} still held by ${pid || 'an unknown process'} after 2 minutes`);
      else await Bun.sleep(20);
    }
  }
  try { await writeFile(owner, String(process.pid)); return await task(); } finally { await rm(lockDir, { recursive: true, force: true }); }
}

/** Runs the pinned moon CLI against the real workspace and parses its JSON stdout. */
export function moonJson(args: string[], cwd = root): Promise<any> {
  const key = `${cwd}\0${args.join('\0')}`;
  if (!memo.has(key)) {
    memo.set(key, withMoonLock(async () => {
      const { MOON_BASE, MOON_HEAD, ...environment } = process.env; // checks.yml pins both for its shallow jobs
      const child = Bun.spawn([process.execPath, moonScript, ...args], {
        cwd, stdout: 'pipe', stderr: 'pipe', env: { ...environment, MOON_TELEMETRY: 'false', NO_COLOR: '1' },
      });
      const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (status !== 0) throw new Error(`moon ${args.join(' ')} exited ${status}: ${error}`);
      return JSON.parse(output);
    }, cwd));
  }
  return memo.get(key)!;
}

export type MoonTask = {
  target: string; command: string; args?: string[]; script?: string; env?: Record<string, string>;
  deps?: { target: string }[]; options: Record<string, any>;
};

/** The resolved task exactly as moon would run it. */
export const moonTask = (target: string): Promise<MoonTask> => moonJson(['task', target, '--json']);

/** The shell-visible command line of a resolved task (a `script`, or `command` followed by `args`). */
export const commandLine = (task: MoonTask) => task.script ?? [task.command, ...(task.args ?? [])].join(' ');

/** Every task target moon would execute for the given CLI targets, with dependencies. */
export async function plannedTargets(...targets: string[]): Promise<string[]> {
  const graph = await moonJson(['action-graph', ...targets, '--json']);
  return Object.values<any>(graph.data).filter(node => node.action === 'run-task').map(node => node.params.target as string).sort();
}
