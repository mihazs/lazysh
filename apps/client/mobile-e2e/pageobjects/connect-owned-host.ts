import Home from './home.page';
import ConnectDialog from './components/connect-dialog.component';
import HostEditor from './components/host-editor.component';
import HostsList from './components/hosts-list.component';
import Terminal from './terminal.page';
import {grantPermission} from '../support/app';
import {hostName, readEndpoint, type HostKind} from '../support/hosts';

/**
 * Connects to a saved owned host: signs in with the fixture's generated key and trusts only the fingerprint the fixture generated.
 * A host connected before in this app's data is already trusted, so `trusted` skips the review that is then not shown.
 */
export async function signInOwnedHost(name: string, kind: HostKind = 'ssh', trusted = false) {
  const endpoint = await readEndpoint(kind);
  await HostsList.connectTo(name);
  await ConnectDialog.pasteIdentity(endpoint.privateKey);
  await ConnectDialog.connectWithKey();
  if (!trusted) {
    const shown = await ConnectDialog.shownFingerprint();
    if (shown !== endpoint.fingerprint) throw new Error(`The host key shown for ${name} is not the one the fixture generated`);
    await ConnectDialog.trustHostKey();
  }
  // A spec starts from a terminal that is on screen, not from one that is still being drawn.
  await Terminal.waitForTerminal(name);
}

/**
 * Adds the owned host through the real editor, signs in with its generated key and trusts the fingerprint it shows. The
 * trust step compares the fingerprint with the one the fixture generated and refuses a different key. Starts from the empty
 * home, so call it in a `before` hook or right after `resetApp()`. Returns the host name the terminal is titled with.
 */
export async function connectOwnedHost(options: {kind?: HostKind; label?: string; notifications?: 'granted' | 'ask'} = {}) {
  const kind = options.kind ?? 'ssh';
  const endpoint = await readEndpoint(kind);
  // The first connection asks for POST_NOTIFICATIONS and the system dialog covers the WebView. Grant it first, like the
  // instrumented owned-SSH cases; a test of that dialog passes `notifications: 'ask'`. device.ts restores the permission.
  if ((options.notifications ?? 'granted') === 'granted') await grantPermission('android.permission.POST_NOTIFICATIONS');
  const name = hostName(options.label ?? 'host');
  await Home.openHostEditor();
  await HostEditor.fill({name, hostname: endpoint.host, port: endpoint.port, username: endpoint.username});
  await HostEditor.useSsh();
  await HostEditor.saveHost();
  await signInOwnedHost(name, kind);
  return name;
}
