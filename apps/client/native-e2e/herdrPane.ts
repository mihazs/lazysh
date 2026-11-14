import {readlink} from 'node:fs/promises';
import {join} from 'node:path';
import {descendants,identity} from '../../../tests/support/ownedProcess';
import type {HerdrFixture} from '../../../tests/support/androidHerdr';

/** Herdr clients on the fixture's host: its own `herdr` binary running under the owned sshd (the server is not). */
export async function herdrClients(herdr:HerdrFixture) {
  const root=await identity(herdr.ssh.daemon.child.pid!);
  if(!root)throw new Error('Owned sshd is not running');
  const binary=join(herdr.ssh.directory,'bin','herdr');
  let clients=0;
  for(const member of await descendants(root))if(await readlink(`/proc/${member.pid}/exe`).catch(()=>'')===binary)clients++;
  return clients;
}

/** The server's pane inventory, which restore must leave untouched: attach creates no workspace, tab or pane. */
export async function herdrPanes(herdr:HerdrFixture) {
  const snapshot=JSON.parse(await herdr.run(['api','snapshot'])).result.snapshot;
  return {focused:snapshot.focused_pane_id as string,panes:(snapshot.panes as {pane_id:string;terminal_id:string}[]).map(pane=>`${pane.pane_id}:${pane.terminal_id}`).sort()};
}
