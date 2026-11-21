import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const execute = async (argv: string[], cwd: string, env: Record<string, string> = {}) => {
  const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exit, stdout, stderr };
};

/** Run `argv` with a fake `name` build whose Nth run prints and exits as `plan[N - 1]` ("status:output"). */
export async function runFakeBuild(plan: string[], name: string, argv: (build: string, bin: string) => string[], env: Record<string, string> = {}) {
  const fixture = await mkdtemp(join(tmpdir(), 'lazysh-fake-build-')), bin = join(fixture, 'bin'), build = join(bin, name);
  try {
    await mkdir(bin);
    await writeFile(build, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$0.calls"\nstep=$(printf "%s\\n" "$PLAN" | sed -n "$(wc -l < "$0.calls")p")\nprintf "%s\\n" "${step#*:}" >&2\nexit "${step%%:*}"\n', { mode: 0o700 });
    const result = await execute(argv(build, bin), fixture, { PLAN: plan.join('\n'), ...env, PATH: `${bin}:${process.env.PATH}` });
    return { ...result, calls: (await Bun.file(build + '.calls').text()).trim().split('\n') };
  } finally { await rm(fixture, { recursive: true, force: true }); }
}
