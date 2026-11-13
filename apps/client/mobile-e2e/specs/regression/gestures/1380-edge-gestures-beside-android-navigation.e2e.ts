import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import BottomMenu from '../../../pageobjects/components/bottom-menu.component';
import Handles from '../../../pageobjects/components/gesture-handles.component';
import SideMenu from '../../../pageobjects/components/side-menu.component';
import {launchApp, relaunchApp, resetApp} from '../../../support/app';
import {screenSize, swipe} from '../../../support/gestures';
import {
  devicePixelRatio, foregroundPackage, gestureUntil, isGestural, OVERLAYS, readAppInsets, readSystemZones, systemBack, tap, useNavigation, webViewRect,
  type Overlay,
} from '../../../support/navigation';

const APP = 'app.lazysh.client';
const shown = (panel: typeof SideMenu | typeof BottomMenu) => panel.in(() => panel.root.waitForDisplayed({withinViewport: true, timeout: 1500}).then(() => true, () => false));

/** What a person does to open each page on this navigation mode: drag the handle, or swipe in from the screen edge. */
async function openSideMenu(overlay: Overlay) {
  const drag = async () => {
    const {width} = await screenSize();
    if (isGestural(overlay)) {
      const from = await Handles.centreOf(() => Handles.left);
      await swipe(from, {x: from.x + width * 0.6, y: from.y});
    } else await swipe({x: 2, y: (await screenSize()).height / 2}, {x: width * 0.7, y: (await screenSize()).height / 2});
  };
  await gestureUntil(drag, () => shown(SideMenu), 'The side menu');
}

async function openBottomMenu(overlay: Overlay) {
  const {height} = await screenSize();
  const from = isGestural(overlay) ? await Handles.centreOf(() => Handles.bottom)
    : await (async () => { const view = await webViewRect(); return {x: 60, y: view.y + view.height - 12}; })();
  await gestureUntil(() => swipe(from, {x: from.x, y: from.y - height * 0.4}), () => shown(BottomMenu), 'The bottom menu');
}

for (const overlay of OVERLAYS) describe(`#1380 edge gestures beside ${overlay} navigation`, () => {
  before(async function () {
    if (!await useNavigation(overlay)) this.skip();
    await connectOwnedHost({label: `nav-${overlay}`});
  });
  after(resetApp);
  // A test that left the app or a page open must not reach the next one.
  afterEach(async () => {
    await launchApp();
    if (await shown(SideMenu)) await SideMenu.close();
    if (await shown(BottomMenu)) await BottomMenu.closeByButton();
  });

  it('reports the navigation mode, and the Back zones the system reserves, to the app', async () => {
    const [zones, app, ratio] = await Promise.all([readSystemZones(), readAppInsets(), devicePixelRatio()]);
    expect(app.navigation).toBe(isGestural(overlay) ? 'gesture' : 'buttons');
    if (isGestural(overlay)) expect(zones.left).toBeGreaterThan(0); else expect(zones.left).toBe(0);
    expect(Math.abs(app.left * ratio - zones.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(app.right * ratio - zones.right)).toBeLessThanOrEqual(1);
  });

  if (isGestural(overlay)) {
    it('places the left handle beside the Back zone and the bottom handle above the Home zone', async () => {
      const zones = await readSystemZones(), {height} = await screenSize();
      const left = await Handles.boxOf(() => Handles.left), bottom = await Handles.boxOf(() => Handles.bottom);
      expect(left.x).toBeGreaterThanOrEqual(zones.left);
      expect(bottom.y + bottom.height).toBeLessThanOrEqual(height - zones.bottomMandatory);
    });

    it('opens the side menu by tapping the left handle', async () => {
      await gestureUntil(async () => tap(await Handles.centreOf(() => Handles.left)), () => shown(SideMenu), 'The side menu');
      expect(await shown(SideMenu)).toBe(true);
    });
  }

  it('opens the side menu from the left handle or edge, and Back closes it without leaving the app', async () => {
    await openSideMenu(overlay);
    await systemBack(overlay);
    await SideMenu.in(() => expect(SideMenu.root).not.toBeDisplayedInViewport());
    expect(await foregroundPackage()).toBe(APP);
  });

  it('opens the bottom menu from the bottom handle or edge, and Back closes it without leaving the app', async () => {
    await openBottomMenu(overlay);
    await systemBack(overlay);
    await BottomMenu.in(() => expect(BottomMenu.root).not.toBeDisplayedInViewport());
    expect(await foregroundPackage()).toBe(APP);
  });

  it('goes back from the edge instead of opening the side menu when nothing is open', async () => {
    await systemBack(overlay);
    await browser.waitUntil(async () => await foregroundPackage() !== APP, {timeoutMsg: 'Back at rest did not leave the app'});
    // The app went to the background with its WebView: start it again from nothing, so the next look is at a fresh page.
    await relaunchApp();
    await SideMenu.in(() => expect(SideMenu.root).not.toBeDisplayedInViewport());
  });
});
