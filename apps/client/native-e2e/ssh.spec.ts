import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {openOwnedSsh,challengeOwnedSsh,disconnectOwnedSsh,ownedSshGui} from './sshUi';

const fixture=ownedSshGui();

it('trusts the exact ephemeral server and types a non-echoable challenge through the bundled SSH terminal',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true});
  const control=await ssh.client();
  control.child.stdin!.end(`${ssh.challenge}\nexit\n`);
  const output=await control.finish('owned namespace SSH preflight',5000);
  expect(output.includes(ssh.prompt)).toBe(true);
  expect(output.includes(ssh.expected)).toBe(true);
  const gui=fixture.gui=await NativeGui.start();
  const {terminal,owner}=await openOwnedSsh(gui,ssh);
  fixture.captureSafe=true;
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  await disconnectOwnedSsh(gui,terminal);
});
