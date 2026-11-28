import {SshFixture} from '../../../tests/support/sshFixture';
import {NativeGui} from './fixture';
import {typeText} from './sshUi';

type Browser=NonNullable<NativeGui['browser']>;
type Terminal=Awaited<ReturnType<Browser['$']>>;
/** How a multiplexer pane names itself: the command typed into its shell and the identity read back from the screen. */
export type PaneProbe={command:(tag:string)=>string;identity:(text:string,tag:string)=>string|undefined;/** Milliseconds the pane may need to print its first identity; defaults to 20 s. */timeout?:number};
// The typed echo keeps `%s`; only the pane's own printf resolves the pane ID and shell PID.
const probe=(tag:string)=>`printf 'PANE<%s:%s:${tag}>\\n' "$TMUX_PANE" "$$"\n`;
export const paneIdentity=(text:string,tag:string)=>text.match(new RegExp(`PANE<(%[0-9]+):([1-9][0-9]*):${tag}>`))?.slice(1,3).join(':');
export const tmuxProbe:PaneProbe={command:probe,identity:paneIdentity};

/** Types a probe into the visible pane and returns its identity (tmux `%pane:pid` unless `pane` says otherwise) once the pane prints it. */
export async function probePane(browser:Browser,terminal:Terminal,tag:string,timeoutMsg:string,pane:PaneProbe=tmuxProbe) {
  await terminal.click();await typeText(browser,pane.command(tag));
  let identity:string|undefined;
  await browser.waitUntil(async()=>!!(identity=pane.identity(await terminal.getText(),tag)),{timeout:pane.timeout??20_000,timeoutMsg});
  return identity!;
}

/** Attached clients of the fixture's own tmux server, observed through its private socket. */
export async function tmuxClients(ssh:SshFixture) {
  return (await ssh.tmux(['list-clients','-F','#{client_tty}'])).split('\n').filter(Boolean).length;
}
