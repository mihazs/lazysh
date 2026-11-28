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
// The plugin's own bound on one acquisition (packages/display-idle ACQUIRE_LIMIT) plus its Close bound.
const ACQUIRE_AND_CLOSE_MS=6_000;

it('requests a portal idle inhibition only for an opted-in, focused Agent board and closes that exact request when Preferences, focus, the board or the opt-in goes away',async()=>{
  fixture.captureSafe=true;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true});
  const gui=fixture.gui=await NativeGui.start();
  const portal=await gui.portalServer(),pointer=await gui.pointer();
  const {browser,owner}=await openOwnedSsh(gui,ssh);
  const waitFor=(what:string,probe:()=>boolean|Promise<boolean>)=>browser.waitUntil(async()=>probe(),{timeout:10_000,timeoutMsg:`Keep-awake case did not observe: ${what}`});
  const requests=(event:'inhibit'|'close')=>portalRecords(portal,event);
  const settle=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

  gui.stage='owned Agent board setup';
  await (await browser.$('button[data-workspace-mode="agents"]')).click();
  await (await browser.$('button=Activity')).click();
  await (await browser.$('section.agent-panel:not([hidden])')).waitForDisplayed({timeout:20_000});
  // The switch lives on Preferences > Agents, which the board's Setup button opens over the board; it is in the document only while Preferences is open.
  // Preferences covers the board, so while it is open the board owns no request and the control reads "off" or "paused"; ownership shows only in the portal's records.
  const CONTROL='[data-settings-page="agents"]:not([hidden]) .keep-awake-control';
  const openSettings=async()=>{const setup=await browser.$('section.agent-panel:not([hidden]) button[title="Setup"]');await setup.waitForClickable();await setup.click();await browser.$(CONTROL).waitForDisplayed({timeout:20_000});};
  const closeSettings=async()=>{await (await browser.$('button[aria-label="Close Preferences"]')).click();await browser.$(CONTROL).waitForExist({reverse:true,timeout:10_000});};
  const control=()=>browser.$(CONTROL),checkbox=async()=>(await control()).$('input[type="checkbox"]'),status=async()=>(await control()).$('[role="status"]');
  const shows=(text:string)=>waitFor(`status "${text}"`,async()=>await (await status()).getText()===text);
  const flip=async()=>{const box=await checkbox();await box.waitForEnabled({timeout:10_000});await box.click();};
  const focused=()=>browser.execute(()=>document.hasFocus());
  await openSettings();

  gui.stage='owned keep-awake default off';
  await shows(OFF);
  expect(await (await checkbox()).isSelected()).toBe(false);
  expect(requests('inhibit')).toEqual([]);

  gui.stage='owned keep-awake opt-in';
  await flip();
  await shows(PAUSED);
  // Preferences still covers the board: nothing may be requested until it closes.
  await settle(1500);
  expect(requests('inhibit')).toEqual([]);
  await closeSettings();
  await waitFor('the first request',()=>requests('inhibit').length===1);
  const [first,...others]=requests('inhibit');
  expect(others).toEqual([]);
  // A portal Request handle is /org/freedesktop/portal/desktop/request/<caller>/<token>.
  expect(first).toMatchObject({flags:IDLE,window:'',handle:expect.stringMatching(/^\/org\/freedesktop\/portal\/desktop\/request\/1_[0-9]+\/lazysh_[0-9a-f]{32}$/)});
  expect(requests('close')).toEqual([]);

  gui.stage='owned keep-awake Preferences opened over the board';
  await openSettings();
  await shows(PAUSED);
  await waitFor('Close of the first request',()=>requests('close').length===1);
  expect(requests('close')[0].handle).toBe(first.handle);
  await closeSettings();
  await waitFor('the second request',()=>requests('inhibit').length===2);
  const second=requests('inhibit')[1];
  expect(second.handle).not.toBe(first.handle);

  gui.stage='owned keep-awake window focus loss';
  await pointer.leave();
  await waitFor('the window losing focus',async()=>!await focused());
  await waitFor('Close of the second request',()=>requests('close').length===2);
  expect(requests('close')[1].handle).toBe(second.handle);
  // Nothing may reacquire while the window stays unfocused.
  await settle(1500);
  expect(requests('inhibit')).toHaveLength(2);

  gui.stage='owned keep-awake window focus return';
  await pointer.enter();
  await waitFor('the window regaining focus',focused);
  await waitFor('the third request',()=>requests('inhibit').length===3);
  const third=requests('inhibit')[2];
  expect(third.handle).not.toBe(second.handle);
  expect(requests('close')).toHaveLength(2);

  gui.stage='owned keep-awake board left';
  await (await browser.$('button[data-workspace-mode="workspaces"]')).click();
  await waitFor('Close of the third request',()=>requests('close').length===3);
  expect(requests('close')[2].handle).toBe(third.handle);
  await (await browser.$('button[data-workspace-mode="agents"]')).click();
  await waitFor('the fourth request',()=>requests('inhibit').length===4);
  const fourth=requests('inhibit')[3];
  expect(fourth.handle).not.toBe(third.handle);

  gui.stage='owned keep-awake opt-out';
  await openSettings();
  await waitFor('Close of the fourth request',()=>requests('close').length===4);
  expect(requests('close')[3].handle).toBe(fourth.handle);
  await flip();
  await shows(OFF);
  expect(await (await checkbox()).isSelected()).toBe(false);
  await closeSettings();
  // An opted-out board asks for nothing when it is shown again.
  await settle(1500);
  expect(requests('inhibit')).toHaveLength(4);
  expect(requests('close')).toHaveLength(4);

  gui.stage='owned keep-awake without a portal';
  await portal.stop();
  await openSettings();
  await flip();
  await shows(PAUSED);
  // The failed acquisition happens while the board is shown and ends within the plugin's own bound; Preferences then shows it.
  await closeSettings();
  await settle(ACQUIRE_AND_CLOSE_MS);
  await openSettings();
  await (await (await control()).$('[role="alert"]')).waitForDisplayed({timeout:10_000});
  expect(await (await status()).getText()).not.toBe(ACTIVE);
  expect(requests('inhibit')).toHaveLength(4);
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
},180_000);
