import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {attestQrCamera} from '../../../../tests/support/androidQrOwnership';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The sync test clears app data, so it may only run on the disposable CI emulator. */
export async function ownedSyncEmulator(env: NodeJS.ProcessEnv, attest = attestQrCamera) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || !env.RUNNER_TEMP || env.LAZYSH_ANDROID_QR_EMULATOR_PID_FILE !== join(env.RUNNER_TEMP, 'lazysh-qr-emulator.pid')) {
    throw new Error('Sync acceptance requires the owned GitHub-hosted emulator');
  }
  return attest(env, repository);
}
