import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {attestQrCamera} from '../../../../tests/support/androidQrOwnership';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const syncSpec = '1540-encrypted-sync-webdav.e2e.ts';
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

/** Admit first whenever a CLI override or unresolved pattern could select the CI-only case. */
export async function prepareSyncDevice<T>(env: NodeJS.ProcessEnv, specs: readonly (string | string[])[], args: readonly string[], setup: () => Promise<T>, admit = ownedSyncEmulator) {
  const ambiguous = args.some(arg => /^--(?:spec|suite)(?:=|$)/.test(arg));
  const selected = specs.flat().some(spec => basename(spec) === syncSpec || /[*?\[\]{}]/.test(spec));
  const emulator = hostedRunner(env) || ambiguous || selected ? await admit(env) : undefined;
  return {emulator, device: await setup()};
}

/** WDIO swallows ordinary beforeSession hook errors; terminate this worker before it can create a session. */
export async function failClosedBeforeSession(setup: () => Promise<void>) {
  try { await setup(); } catch {
    console.error('Android pre-session safety check failed; refusing to start the session.');
    process.exit(1);
  }
}
