import {basename, dirname, join, resolve} from 'node:path';
import {globSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {attestQrCamera} from '../../../../tests/support/androidQrOwnership';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const syncSpec = '1540-encrypted-sync-webdav.e2e.ts';
const syncPath = join(repository, 'apps/client/mobile-e2e/specs/regression/sync', syncSpec);
export const hostedRunner = (env: NodeJS.ProcessEnv) => env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';

/** Local default runs omit this destructive CI-only spec before any device session starts. */
export function localSyncSelection(specs: string[], env: NodeJS.ProcessEnv) {
  if (hostedRunner(env) || !specs.some(spec => basename(spec) === syncSpec)) return specs;
  console.warn('Skipping encrypted sync acceptance: it requires an attested GitHub-hosted emulator.');
  return specs.filter(spec => basename(spec) !== syncSpec);
}

/** The sync test clears app data, so it may only run on the disposable CI emulator. */
export async function ownedSyncEmulator(env: NodeJS.ProcessEnv, attest = attestQrCamera) {
  if (!hostedRunner(env)
    || !env.RUNNER_TEMP || env.LAZYSH_ANDROID_QR_EMULATOR_PID_FILE !== join(env.RUNNER_TEMP, 'lazysh-qr-emulator.pid')) {
    throw new Error('Sync acceptance requires the owned GitHub-hosted emulator');
  }
  return attest(env, repository);
}

type Selection = {spec?: string[]; suite?: string[]; suites?: Record<string, string[]>};

/** Admit first whenever the resolved selection contains the CI-only case or cannot be resolved safely. */
export async function prepareSyncDevice<T>(env: NodeJS.ProcessEnv, specs: readonly (string | string[])[], args: readonly string[], setup: () => Promise<T>, admit = ownedSyncEmulator, selection: Selection = {}) {
  const override = Boolean(selection.spec?.length || selection.suite?.length);
  const patterns = override ? [...selection.spec ?? [], ...(selection.suite ?? []).flatMap(name => selection.suites?.[name] ?? ['<unresolved>'])] : specs.flat();
  const uncertain = !override && args.some(arg => /^--(?:spec|suite)(?:=|$)/.test(arg));
  const selected = patterns.some(pattern => {
    let path: string;
    try { path = pattern.startsWith('file:') ? fileURLToPath(pattern) : pattern; } catch { return true; }
    const files = /[*?\[\]{}]/.test(path) ? globSync(path) : [path];
    if (!files.length) return true;
    return files.some(file => {
      if (basename(file) === syncSpec) return true;
      try { return realpathSync(file) === realpathSync(syncPath); } catch { return true; }
    });
  });
  const emulator = uncertain || selected ? await admit(env) : undefined;
  return {emulator, device: await setup()};
}

/** WDIO swallows ordinary beforeSession hook errors; terminate this worker before it can create a session. */
export async function failClosedBeforeSession(setup: () => Promise<void>) {
  try { await setup(); } catch {
    console.error('Android pre-session safety check failed; refusing to start the session.');
    process.exit(1);
  }
}
