import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {HerdrFixture,herdrTools} from '../../../tests/support/androidHerdr';
import {NativeGui} from './fixture';
import {openOwnedRememberedSsh,ownedSshGui} from './sshUi';
import {savePrefixAcrossKill} from './prefixShortcuts';

const fixture=ownedSshGui();

it('sends a saved custom Herdr prefix and a tab number to the real server and keeps the prefix across an app kill',async()=>{
  fixture.captureSafe=false;
  const herdr=await HerdrFixture.start(herdrTools());fixture.ssh=herdr;
  // The server's prefix is the one the app must learn from the user, not Herdr's default `ctrl+b`.
  // The fixture writes the same configuration for the release (`herdr`) and development (`herdr-dev`) channels.
  for(const channel of ['herdr','herdr-dev'])await appendFile(join(herdr.ssh.environment!.XDG_CONFIG_HOME!,channel,'config.toml'),'[keys]\nprefix = "ctrl+a"\n');
  await herdr.run(['server','reload-config']);
  const focusedTab=async()=>JSON.parse(await herdr.run(['api','snapshot'])).result.snapshot.focused_tab_id as string;
  const tabs=JSON.parse(await herdr.run(['tab','list'])).result.tabs as {tab_id:string;number:number}[];
  expect(tabs.map(tab=>tab.number)).toEqual([1,2]);
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  await openOwnedRememberedSsh(gui,herdr.ssh,{kind:'herdr',name:herdr.name});
  expect(await focusedTab()).toBe(tabs[0].tab_id);

  const {relaunched,shortcuts}=await savePrefixAcrossKill(gui,'herdr',`Owned SSH GUI host / ${herdr.name}`);

  gui.stage='owned prefix and tab number reach the Herdr server';
  await (await shortcuts.$('button=Tab 2')).click();
  await relaunched.waitUntil(async()=>await focusedTab()===tabs[1].tab_id,{timeout:20_000,timeoutMsg:'Tab 2 did not become the focused Herdr tab'});
  await (await shortcuts.$('button=Tab 1')).click();
  await relaunched.waitUntil(async()=>await focusedTab()===tabs[0].tab_id,{timeout:20_000,timeoutMsg:'Tab 1 did not become the focused Herdr tab'});
},240_000);
