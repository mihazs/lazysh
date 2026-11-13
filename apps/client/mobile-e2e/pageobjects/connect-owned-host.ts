import Home from './home.page';
import ConnectDialog from './components/connect-dialog.component';
import HostEditor from './components/host-editor.component';
import HostsList from './components/hosts-list.component';
import {grantPermission} from '../support/app';
import {hostName, readEndpoint, type HostKind} from '../support/hosts';

/**
 * Adds the owned host through the real editor, signs in with its generated key and trusts the fingerprint it shows. The
 * trust step compares the fingerprint with the one the fixture generated and refuses a different key. Starts from the empty
 * home, so call it in a `before` hook or right after `resetApp()`. Returns the host name the terminal is titled with.
 */
export async function connectOwnedHost(options: {kind?: HostKind; label?: string; notifications?: 'granted' | 'ask' | (() => Promise<void>)} = {}) {
  const endpoint = await readEndpoint(options.kind ?? 'ssh');
  // The first connection asks for POST_NOTIFICATIONS and the system dialog covers the WebView. Grant it first, like the
  // instrumented owned-SSH cases; a test of that dialog passes `notifications: 'ask'` to leave it ungranted, or a function that
  // asserts on the dialog and answers it.
  // device.ts restores the permission.
  if ((options.notifications ?? 'granted') === 'granted') await grantPermission('android.permission.POST_NOTIFICATIONS');
  const name = hostName(options.label ?? 'host');
  await Home.openHostEditor();
  await HostEditor.fill({name, hostname: endpoint.host, port: endpoint.port, username: endpoint.username});
  await HostEditor.useSsh();
  await HostEditor.saveHost();
  await HostsList.connectTo(name);
  await ConnectDialog.signIn(endpoint.privateKey);
  const shown = await ConnectDialog.shownFingerprint();
  if (shown !== endpoint.fingerprint) throw new Error(`The host key shown for ${name} is not the one the fixture generated`);
  await ConnectDialog.trustHostKey();
  // The app asks once the connected session is adopted, so the dialog opens after the host key is trusted.
  if (typeof options.notifications === 'function') await options.notifications();
  return name;
}
