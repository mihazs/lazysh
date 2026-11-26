import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SshFixture} from './sshFixture';

/**
 * Helper of apps/client/bench/waydroid-lane.sh --owned-ssh-fixture: starts the owned OpenSSH server (loopback), writes the fixture the
 * on-device case reads into the directory given as the first argument, prints `{port,nonce,file}` as one JSON line and keeps the server
 * until SIGTERM or SIGINT, then retires it and its fixture directory.
 */
// The acceptance suite shares its shell across all cases, including their recovery timeouts.
const fixture = await SshFixture.start(undefined, {shellSeconds: 600});
try {
  const {nonce, port, username, privateKey, fingerprint, prompt, challenge, expected} = fixture;
  const file = join(process.argv[2], 'fixture.json');
  await writeFile(file, JSON.stringify({nonce, port, username, privateKey, fingerprint, prompt, challenge, expected}), {mode: 0o600});
  console.log(JSON.stringify({port, nonce, file}));
  await new Promise<void>(resolve => {process.once('SIGTERM', () => resolve()); process.once('SIGINT', () => resolve());});
} finally {
  await fixture.stop();
}
