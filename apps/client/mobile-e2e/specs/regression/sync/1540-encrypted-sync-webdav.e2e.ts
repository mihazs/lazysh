import {randomBytes} from 'node:crypto';
import {expect} from '@wdio/globals';
import Home from '../../../pageobjects/home.page';
import HostEditor from '../../../pageobjects/components/host-editor.component';
import HostsList from '../../../pageobjects/components/hosts-list.component';
import SyncPanel from '../../../pageobjects/components/sync-panel.component';
import {relaunchApp, resetApp} from '../../../support/app';
import {adbFor} from '../../../support/device';
import {reversePort, startOwnedWebdav, trustOwnedCa, type OwnedWebdav} from '../../../support/webdav';
import {ownedSyncEmulator} from '../../../support/owned-sync-emulator';

// Encrypted sync through the real Sync panel against an owned HTTPS WebDAV server (#1540, child of #17). The server runs on the
// host, the guest reaches it as 127.0.0.1 through `adb reverse`, and the app trusts only the owned CA that the debug build is
// given (support/webdav.ts). The server sees what a provider would: requests, status codes and ciphertext. Physical devices and
// a hosted WebDAV provider are not covered.
const SETTINGS = 'lazysh-settings-v1.age';
const CREDENTIALS = 'lazysh-credentials-v1.age';
const request = ({method, name, status}: {method: string; name: string; status: number}) => `${method} ${name} ${status}`;

describe('Encrypted sync against an owned WebDAV server', () => {
  const adb = adbFor(process.env.ANDROID_SERIAL ?? '');
  let webdav: OwnedWebdav | undefined, unforward: (() => Promise<void>) | undefined;
  let emulator: Awaited<ReturnType<typeof ownedSyncEmulator>> | undefined;
  const checkEmulator = async () => { if (!emulator) throw new Error('Owned emulator was not admitted'); await emulator.check(); };
  const server = () => { if (!webdav) throw new Error('The owned WebDAV server did not start'); return webdav; };
  const account = (extra: {recoveryKey?: string} = {}) =>
    ({url: server().url, username: server().username, password: server().password, settings: true, ...extra});

  before(async () => {
    emulator = await ownedSyncEmulator(process.env);
    webdav = await startOwnedWebdav();
    await checkEmulator();
    unforward = await reversePort(adb, webdav.port);
  });
  // Every test starts from an app with no data and a server with no objects, and leaves the same behind.
  beforeEach(async () => {
    await checkEmulator();
    await resetApp();
    server().objects.clear();
    server().requests.length = 0;
  });
  after(async () => {
    try { if (emulator) { await checkEmulator(); await resetApp(); } } finally {
      try { if (emulator && unforward) { await checkEmulator(); await unforward(); } } finally { await webdav?.stop(); }
    }
  });

  it('enrolls, keeps the recovery key in the native credential store, and uploads nothing before an explicit action', async () => {
    await checkEmulator(); await trustOwnedCa(adb, server());
    await SyncPanel.open();
    await SyncPanel.configure(account());
    await SyncPanel.in(() => expect(SyncPanel.status).toHaveText('Encrypted sync configured. Nothing has been uploaded.'));
    const recoveryDigest = await SyncPanel.shownRecoveryKey();
    expect(recoveryDigest).toMatch(/^[0-9a-f]{64}$/);
    // Credentials stay off unless enabled, and enrolling reached out to no server at all.
    await SyncPanel.in(async () => {
      await expect(SyncPanel.uploadSettings).toBeEnabled();
      await expect(SyncPanel.uploadCredentials).toBeDisabled();
      await expect(SyncPanel.previewCredentials).toBeDisabled();
    });
    expect(server().requests).toEqual([]);
    // The key shown on first enrollment is gone from the page once hidden; it comes back from the native store after the app restarts.
    await SyncPanel.hideRecoveryKey();
    await SyncPanel.in(() => expect(SyncPanel.recoveryKey).not.toBeDisplayed());
    await relaunchApp();
    await SyncPanel.open();
    await SyncPanel.showRecoveryKey();
    expect(await SyncPanel.shownRecoveryKey()).toBe(recoveryDigest);
    expect(server().requests).toEqual([]);
  });

  it('uploads settings as ciphertext, and a reset install enrolled with the recovery key previews and applies the host list', async function () {
    this.timeout(300_000);
    // Its own nonce, so the case does not depend on which owned SSH hosts the run started.
    const source = {name: `e2e-${randomBytes(4).toString('hex')}-sync-source`, hostname: 'sync-source.example.invalid', port: 2222, username: 'syncer'};
    await checkEmulator(); await trustOwnedCa(adb, server());
    await Home.openHostEditor();
    await HostEditor.fill(source);
    await HostEditor.saveHost();
    await HostsList.in(() => expect(HostsList.connectButton(source.name)).toBeDisplayed());
    await SyncPanel.open();
    const recoveryKey = `LAZYSH-SYNC-V1-${randomBytes(32).toString('hex')}`;
    await SyncPanel.configure(account({recoveryKey}));
    await SyncPanel.uploadSettingsNow();
    await SyncPanel.in(() => expect(SyncPanel.status).toHaveText('Encrypted settings uploaded.'));
    // The server holds one age (scrypt) ciphertext for settings, no credentials resource, and none of what it must not learn.
    expect([...server().objects.keys()]).toEqual([SETTINGS]);
    expect(server().requests.map(request)).toEqual([`GET ${SETTINGS} 404`, `PUT ${SETTINGS} 201`]);
    const stored = server().objects.get(SETTINGS)!.body;
    expect(stored.subarray(0, 32).toString('latin1')).toMatch(/^age-encryption\.org\/v1\n-> scrypt /);
    for (const secret of [source.name, source.hostname, source.username, recoveryKey, server().password]) expect(stored.includes(secret)).toBe(false);
    expect(server().objects.has(CREDENTIALS)).toBe(false);

    // A second install is the same app with its data cleared: it knows nothing until it is enrolled with the recovery key.
    await checkEmulator(); await resetApp();
    await checkEmulator(); await trustOwnedCa(adb, server());
    await Home.in(() => expect(Home.addFirstHost).toBeDisplayed());
    await SyncPanel.open();
    await SyncPanel.configure(account({recoveryKey}));
    await SyncPanel.in(async () => {
      await expect(SyncPanel.status).toHaveText('Encrypted sync configured. Nothing has been uploaded.');
      await expect(SyncPanel.recoveryKey).not.toBeDisplayed();
    });
    await SyncPanel.previewRemoteSettings();
    await SyncPanel.in(async () => {
      await expect(SyncPanel.reviewedHosts).toBeElementsArrayOfSize(1);
      const [host] = await SyncPanel.reviewedHosts;
      await expect(host).toHaveText(expect.stringContaining(source.name));
      await expect(host).toHaveText(expect.stringContaining(`${source.username}@${source.hostname}:${source.port}`));
    });
    await SyncPanel.applyReviewed();
    await SyncPanel.in(() => expect(SyncPanel.status).toHaveText('Imported 1 host and 0 credential entries.'));
    await SyncPanel.close();
    await HostsList.in(() => expect(HostsList.connectButton(source.name)).toBeDisplayed());
    // Applying read the ciphertext; the only write of the whole journey is the first install's upload.
    expect(server().requests.filter(({method}) => method === 'PUT')).toHaveLength(1);
    expect(server().requests.filter(({method, status}) => method === 'GET' && status === 200).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a certificate from a root the app was not given, and accepts the same server once it is given', async () => {
    await SyncPanel.open();
    await SyncPanel.configure(account());
    await SyncPanel.previewRemoteSettings();
    await SyncPanel.in(() => expect(SyncPanel.alert).toHaveText(expect.stringContaining('Cannot fetch encrypted sync data')));
    expect(server().requests).toEqual([]);
    await checkEmulator(); await trustOwnedCa(adb, server());
    await SyncPanel.previewRemoteSettings();
    await SyncPanel.in(() => expect(SyncPanel.alert).toHaveText('No remote snapshot for this category'));
    expect(server().requests.map(request)).toEqual([`GET ${SETTINGS} 404`]);
  });
});
