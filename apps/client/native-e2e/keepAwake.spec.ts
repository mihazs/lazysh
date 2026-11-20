import {expect,it} from 'vitest';
import type {OwnedProcess} from '../../../tests/support/ownedProcess';
import {SshFixture} from '../../../tests/support/sshFixture';
import {NativeGui} from './fixture';
import {openOwnedSsh,ownedSshGui} from './sshUi';

const fixture=ownedSshGui();
type PortalRecord={event:'ready'|'inhibit'|'close';handle:string;window:string;flags:number;reason:string};
const portalRecords=(portal:OwnedProcess,event:'inhibit'|'close')=>
  portal.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line) as PortalRecord).filter(record=>record.event===event);
const ACTIVE='This board owns an acknowledged idle-inhibition request.',PAUSED='Keep awake is paused until this board is visible and focused.',OFF='Keep awake is off.';
// The INHIBIT_IDLE flag of org.freedesktop.portal.Inhibit.
const IDLE=8;

it('requests a portal idle inhibition only for an opted-in, focused Agent board and closes that exact request when focus, the board or the opt-in goes away',async()=>{
  fixture.captureSafe=true;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true});
  const gui=fixture.gui=await NativeGui.start();
  const portal=await gui.portalServer(),pointer=await gui.pointer();
  const {browser,owner}=await openOwnedSsh(gui,ssh);
  const waitFor=(what:string,probe:()=>boolean|Promise<boolean>)=>browser.waitUntil(async()=>probe(),{timeout:10_000,timeoutMsg:`Keep-awake case did not observe: ${what}`});
  const requests=(event:'inhibit'|'close')=>portalRecords(portal,event);

  gui.stage='owned Agent board setup';
  await (await browser.$('button[data-workspace-mode="agents"]')).click();
  await (await browser.$('button=Activity')).click();
  const panel=await browser.$('section.agent-panel:not([hidden])');await panel.waitForDisplayed({timeout:20_000});
  const setup=await panel.$('button[title="Setup"]');await setup.waitForClickable();await setup.click();
  const control=await panel.$('.keep-awake-control'),checkbox=await control.$('input[type="checkbox"]'),status=await control.$('[role="status"]');
  const shows=(text:string)=>waitFor(`status "${text}"`,async()=>await status.getText()===text);
  const focused=()=>browser.execute(()=>document.hasFocus());

  gui.stage='owned keep-awake default off';
  await shows(OFF);
  expect(await checkbox.isSelected()).toBe(false);
  expect(requests('inhibit')).toEqual([]);

  gui.stage='owned keep-awake opt-in';
  await checkbox.click();
  await shows(ACTIVE);
  const [first,...others]=requests('inhibit');
  expect(others).toEqual([]);
  // A portal Request handle is /org/freedesktop/portal/desktop/request/<caller>/<token>.
  expect(first).toMatchObject({flags:IDLE,window:'',handle:expect.stringMatching(/^\/org\/freedesktop\/portal\/desktop\/request\/1_[0-9]+\/lazysh_[0-9a-f]{32}$/)});
  expect(requests('close')).toEqual([]);

  gui.stage='owned keep-awake window focus loss';
  await pointer.leave();
  await waitFor('the window losing focus',async()=>!await focused());
  await shows(PAUSED);
  await waitFor('Close of the first request',()=>requests('close').length===1);
  expect(requests('close')[0].handle).toBe(first.handle);
  // Nothing may reacquire while the window stays unfocused.
  await new Promise(resolve=>setTimeout(resolve,1500));
  expect(requests('inhibit')).toHaveLength(1);

  gui.stage='owned keep-awake window focus return';
  await pointer.enter();
  await waitFor('the window regaining focus',focused);
  await shows(ACTIVE);
  const second=requests('inhibit')[1];
  expect(requests('inhibit')).toHaveLength(2);
  expect(second.handle).not.toBe(first.handle);
  expect(requests('close')).toHaveLength(1);

  gui.stage='owned keep-awake board left';
  await (await browser.$('button[data-workspace-mode="workspaces"]')).click();
  await waitFor('Close of the second request',()=>requests('close').length===2);
  expect(requests('close')[1].handle).toBe(second.handle);
  await (await browser.$('button[data-workspace-mode="agents"]')).click();
  await shows(ACTIVE);
  const third=requests('inhibit')[2];
  expect(requests('inhibit')).toHaveLength(3);
  expect(third.handle).not.toBe(second.handle);

  gui.stage='owned keep-awake opt-out';
  await checkbox.click();
  await shows(OFF);
  await waitFor('Close of the third request',()=>requests('close').length===3);
  expect(requests('close')[2].handle).toBe(third.handle);
  expect(await checkbox.isSelected()).toBe(false);

  gui.stage='owned keep-awake without a portal';
  await portal.stop();
  await checkbox.click();
  await (await control.$('[role="alert"]')).waitForDisplayed({timeout:10_000});
  expect(await status.getText()).not.toBe(ACTIVE);
  expect(requests('inhibit')).toHaveLength(3);
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
},180_000);
