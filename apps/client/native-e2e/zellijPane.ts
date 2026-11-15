import {SshFixture} from '../../../tests/support/sshFixture';
import type {PaneProbe} from './tmuxPane';

/** The pinned Zellij the owned fixture runs: CI installs 0.45.1 outside the checkout and names it here. */
export function pinnedZellij() {
  const zellij=process.env.LAZYSH_TEST_ZELLIJ;
  if(!zellij?.startsWith('/'))throw new Error('The pinned Zellij binary (LAZYSH_TEST_ZELLIJ) is required');
  return zellij;
}

// The shell of a Zellij pane is a direct child of its server, so `pane:server:shell` names one shell of one server.
// The typed echo keeps `%s`; only the pane's own printf resolves the three numbers.
export const zellijProbe:PaneProbe={
  // A cold Zellij compiles its plugins on first start, which slows a loaded runner's first shell.
  timeout:45_000,
  command:tag=>`printf 'PANE<%s:%s:%s:${tag}>\\n' "$ZELLIJ_PANE_ID" "$PPID" "$$"\n`,
  identity:(text,tag)=>text.match(new RegExp(`PANE<([0-9]+):([1-9][0-9]*):([1-9][0-9]*):${tag}>`))?.slice(1,4).join(':'),
};

/** Clients attached to one session of the fixture's own Zellij, observed through its private runtime directory. */
export async function zellijClients(ssh:SshFixture,name:string) {
  // The first line is the column header; a session with no client lists only that.
  return (await ssh.zellij(['--session',name,'action','list-clients'])).split('\n').filter(Boolean).length-1;
}

/** The fixture's live Zellij sessions; Zellij exits 1, not with an empty list, when none is left. */
export async function zellijSessions(ssh:SshFixture) {
  const listing=await ssh.zellij(['list-sessions','--short','--no-formatting']).catch(error=>{
    if(/exit=1$/.test(String((error as Error).message)))return '';
    throw error;
  });
  return listing.split('\n').filter(Boolean);
}
