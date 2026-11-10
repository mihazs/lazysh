import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {challengeOwnedSsh,disconnectOwnedSsh,enterOwnedKey,openOwnedSshWith,ownedSshGui} from './sshUi';
import {SshFixture} from '../../../tests/support/sshFixture';

const fixture=ownedSshGui();

it('falls back from unavailable Mosh and ET to the trusted SSH terminal',async()=>{
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,companion:true});
  const gui=fixture.gui=await NativeGui.start();
  const {browser,terminal,owner}=await openOwnedSshWith(gui,ssh,async connect=>{
    await (await connect.$('summary')).click();
    await (await connect.$('select')).selectByAttribute('value','auto');
    await (await (await connect.$('label*=Mosh server path')).$('input')).setValue(`${ssh.directory}/missing-mosh-server`);
    await (await (await connect.$('label*=ET terminal path')).$('input')).setValue(`${ssh.directory}/missing-etterminal`);
    await enterOwnedKey(gui,ssh,connect);
  });
  fixture.captureSafe=true;
  const notice=await browser.$('.browser-banner[role="status"]');
  await notice.waitForDisplayed();
  const text=await notice.getText();
  expect(text).toContain('Auto selected SSH.');
  expect(text).toContain('Mosh: Mosh server failed to start.');
  expect(text).toContain('Eternal Terminal: ET helper did not start.');
  expect(text.indexOf('Mosh:')).toBeLessThan(text.indexOf('Eternal Terminal:'));
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  await disconnectOwnedSsh(gui,terminal);
});
