import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
export const moonScript = join(root, 'node_modules/@moonrepo/cli/moon.js');
const memo = new Map<string, Promise<any>>();

/** Runs the pinned moon CLI against the real workspace and parses its JSON stdout. */
export function moonJson(args: string[], cwd = root): Promise<any> {
  const key = `${cwd}\0${args.join('\0')}`;
  if (!memo.has(key)) {
    memo.set(key, (async () => {
      const child = Bun.spawn([process.execPath, moonScript, ...args], {
        cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, MOON_TELEMETRY: 'false', NO_COLOR: '1' },
      });
      const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (status !== 0) throw new Error(`moon ${args.join(' ')} exited ${status}: ${error}`);
      return JSON.parse(output);
    })());
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
