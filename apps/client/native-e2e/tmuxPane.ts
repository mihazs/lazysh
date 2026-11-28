import {SshFixture} from '../../../tests/support/sshFixture';
import {NativeGui} from './fixture';
import {typeText} from './sshUi';

type Browser=NonNullable<NativeGui['browser']>;
type Terminal=Awaited<ReturnType<Browser['$']>>;
// The typed echo keeps `%s`; only the pane's own printf resolves the pane ID and shell PID.
const probe=(tag:string)=>`printf 'PANE<%s:%s:${tag}>\\n' "$TMUX_PANE" "$$"\n`;
export const paneIdentity=(text:string,tag:string)=>text.match(new RegExp(`PANE<(%[0-9]+):([1-9][0-9]*):${tag}>`))?.slice(1,3).join(':');

/** Types a probe into the visible tmux pane and returns its `%pane:pid` once the pane prints it. */
export async function probePane(browser:Browser,terminal:Terminal,tag:string,timeoutMsg:string) {
  await terminal.click();await typeText(browser,probe(tag));
  let identity:string|undefined;
  await browser.waitUntil(async()=>!!(identity=paneIdentity(await terminal.getText(),tag)),{timeout:20_000,timeoutMsg});
  return identity!;
}

/** Attached clients of the fixture's own tmux server, observed through its private socket. */
export async function tmuxClients(ssh:SshFixture,server='default') {
  return (await ssh.tmux(['list-clients','-F','#{client_tty}'],server)).split('\n').filter(Boolean).length;
}
