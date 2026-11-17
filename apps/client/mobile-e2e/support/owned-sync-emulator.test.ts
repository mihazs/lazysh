import {expect, test} from 'bun:test';
import {localSyncSelection, ownedSyncEmulator, prepareSyncDevice} from './owned-sync-emulator';
import type {attestQrCamera} from '../../../../tests/support/androidQrOwnership';

const hosted = {CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/runner',
  LAZYSH_ANDROID_QR_EMULATOR_PID_FILE: '/runner/lazysh-qr-emulator.pid'};

test('sync acceptance rejects local and incorrectly nominated devices before attestation', async () => {
  let calls = 0;
  const attest = (async () => { calls++; return {check: async () => {}}; }) as typeof attestQrCamera;
  for (const env of [{}, {...hosted, RUNNER_ENVIRONMENT: 'self-hosted'}, {...hosted, GITHUB_ACTIONS: 'false'},
    {...hosted, LAZYSH_ANDROID_QR_EMULATOR_PID_FILE: '/other/pid'}]) {
    await expect(ownedSyncEmulator(env, attest)).rejects.toThrow('owned GitHub-hosted emulator');
  }
  expect(calls).toBe(0);
  const admitted = await ownedSyncEmulator(hosted, attest);
  expect(calls).toBe(1);
  await admitted.check();
});

test('sync acceptance propagates a failed emulator attestation', async () => {
  const attest = (async () => { throw new Error('ownership failed'); }) as typeof attestQrCamera;
  await expect(ownedSyncEmulator(hosted, attest)).rejects.toThrow('ownership failed');
});

test('device setup happens only after admission for the sync case or an ambiguous override', async () => {
  const events: string[] = [];
  const admit = async () => { events.push('admit'); return {check: async () => {}}; };
  const setup = async () => { events.push('setup'); return 'device'; };
  const sync = '/repo/specs/regression/sync/1540-encrypted-sync-webdav.e2e.ts';
  await prepareSyncDevice(hosted, [sync], [], setup, admit);
  expect(events).toEqual(['admit', 'setup']);
  events.length = 0;
  await expect(prepareSyncDevice({}, ['/other.e2e.ts'], ['--spec'], setup,
    async () => { events.push('reject'); throw new Error('not owned'); })).rejects.toThrow('not owned');
  expect(events).toEqual(['reject']);
  events.length = 0;
  expect(localSyncSelection([sync, '/other.e2e.ts'], {})).toEqual(['/other.e2e.ts']);
  await prepareSyncDevice({}, ['/other.e2e.ts'], [], setup, admit);
  expect(events).toEqual(['setup']);
});
