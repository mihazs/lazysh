import {expect,type Page} from '@playwright/test';
import {openLocalizedApp} from './localizedApp';
import type {mountHerdrCreate} from './HerdrCreateHarness';
declare global {interface Window {herdrCreate:ReturnType<typeof mountHerdrCreate>;}}

/** Mounts the real Herdr Spaces view over the recorded synthetic bridge and waits for the named space. */
export async function mountHerdrSpaces(page:Page,options:Parameters<typeof mountHerdrCreate>[0]={},space='Development') {
  await openLocalizedApp(page,'en');
  await page.evaluate(async options=>{const{mountHerdrCreate}=await import('/e2e/fixtures/HerdrCreateHarness.tsx');window.herdrCreate=mountHerdrCreate(options);},options);
  await expect(page.getByRole('button',{name:space,exact:false}).first()).toBeVisible();
}
