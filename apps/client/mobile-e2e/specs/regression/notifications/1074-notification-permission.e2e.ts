import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import AndroidNotificationSettings from '../../../pageobjects/components/android-notification-settings.component';
import NotificationShade from '../../../pageobjects/components/notification-shade.component';
import PermissionDialog from '../../../pageobjects/components/permission-dialog.component';
import Terminal from '../../../pageobjects/terminal.page';
import {grantPermission, resetApp, revokePermission} from '../../../support/app';
import {readEndpoint} from '../../../support/hosts';
import {isGranted} from '../../../support/permissions';

const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS';
const ONGOING = 'lazysh is running';

/** A first install: the permission not granted and the app asking for the first time, on the empty home. */
async function freshInstall() {
  await revokePermission(POST_NOTIFICATIONS);
  await resetApp();
}
/**
 * The system dialog opens over the workspace a moment after the first session is connected. This reads what the dialog says, then
 * answers it as a person would, and hands the text back to the test.
 */
function answer(choice: 'allow' | 'deny', seen: {message?: string}) {
  return async () => {
    seen.message = await PermissionDialog.in(async () => { await PermissionDialog.root.waitForDisplayed({timeout: 30_000, timeoutMsg: 'The system notification permission dialog did not appear'}); return PermissionDialog.root.getText(); });
    if (choice === 'allow') await PermissionDialog.allowIt(); else await PermissionDialog.denyIt();
  };
}
const ongoingNotificationIsInTheShade = async () => {
  await NotificationShade.open();
  await NotificationShade.in(() => expect(NotificationShade.entry(ONGOING)).toBeDisplayed());
  await NotificationShade.close();
};

describe('#1074 notification permission on the first connection', () => {
  describe('denied', () => {
    const seen: {message?: string} = {};
    let name: string;
    before(async () => { await freshInstall(); name = await connectOwnedHost({notifications: answer('deny', seen)}); });
    after(async () => { await NotificationShade.close(); await resetApp(); });

    it('asks with the system permission dialog, and a denial leaves the connection and the terminal usable', async () => {
      expect(seen.message).toContain('notifications');
      expect(await isGranted(POST_NOTIFICATIONS)).toBe(false);
      const {prompt} = await readEndpoint();
      await Terminal.in(() => expect(Terminal.screen(name)).toHaveText(expect.stringContaining(prompt)));
    });

    it('offers the system notification settings, and the notification appears once it is granted there', async () => {
      await AndroidNotificationSettings.open();
      await AndroidNotificationSettings.openAndroidSettings();
      await browser.waitUntil(async () => await browser.getCurrentPackage() === 'com.android.settings', {timeoutMsg: 'Android notification settings did not open'});
      // The person turns the app's notifications on in the system settings: the same grant, made from outside the app.
      await grantPermission(POST_NOTIFICATIONS);
      await browser.back();
      await browser.waitUntil(async () => await browser.getCurrentPackage() === 'app.lazysh.client', {timeoutMsg: 'Back from the system settings did not return to the app'});
      await ongoingNotificationIsInTheShade();
    });
  });

  describe('allowed', () => {
    const seen: {message?: string} = {};
    before(async () => { await freshInstall(); await connectOwnedHost({notifications: answer('allow', seen)}); });
    after(async () => { await NotificationShade.close(); await resetApp(); });

    it('posts the ongoing notification, which the notification shade shows while the connection lives', async () => {
      expect(seen.message).toContain('notifications');
      expect(await isGranted(POST_NOTIFICATIONS)).toBe(true);
      await ongoingNotificationIsInTheShade();
    });
  });
});
