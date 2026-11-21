import {expect,type Page} from '@playwright/test';
import {openHistoryWorkspace} from './terminalHistory';

export type Engine='native'|'xterm';
/** The terminal container of the pane the native surface harness mounts. */
export const canvas='.terminal-canvas';

/** Mounts `engine`'s pane in the app's own shell chain (`NativeSurfaceHarness.tsx`) and waits for its container. */
export async function mountNativeSurface(page:Page,engine:Engine,refuse=false) {
  await openHistoryWorkspace(page);
  await page.evaluate(async options=>{
    const fixture=await import('/e2e/fixtures/NativeSurfaceHarness.tsx');
    window.nativeSurface=await fixture.mountNativeSurfaceHarness(options);
  },{engine,refuse});
  await expect(page.locator(canvas)).toBeVisible();
}
