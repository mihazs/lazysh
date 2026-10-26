import {readFileSync} from 'node:fs';
import {expect,type Page} from '@playwright/test';
import type {mountChatFollowHarness} from '../ChatFollowHarness';

declare global {interface Window {
  chatFollow:ReturnType<typeof mountChatFollowHarness>;
  recordedImageFixture:{calls:Record<string,unknown>[];decodes:number;orientations:unknown[];closed:number;urls:number;drafts:number;canvas?:HTMLCanvasElement;hold?:boolean;release?:()=>void};
}}
export const preview=(file:string)=>({mimeType:file.endsWith('.jpg')?'image/jpeg':'image/png',
  data:readFileSync(new URL(file,import.meta.url)).toString('base64'),width:32,height:16});

export async function prepareRecordedImages(page:Page) {
  await page.goto('/');
  await page.evaluate(()=>{
    const f=window.recordedImageFixture={calls:[],decodes:0,orientations:[],closed:0,urls:0,drafts:0} as Window['recordedImageFixture'];
    window.addEventListener('lazysh-prompt-draft',()=>{f.drafts++;});
    const decode=window.createImageBitmap.bind(window);
    window.createImageBitmap=async(...args:Parameters<typeof createImageBitmap>)=>{
      f.decodes++;
      f.orientations.push(args[1]);
      const bitmap=await decode(...args),close=bitmap.close.bind(bitmap);
      bitmap.close=()=>{f.closed++;close();};
      if(f.hold)await new Promise<void>(resolve=>{f.release=resolve;});
      return bitmap;
    };
    const createUrl=URL.createObjectURL.bind(URL);
    URL.createObjectURL=(blob)=>{f.urls++;return createUrl(blob);};
  });
}
export async function optIn(page:Page) {
  await page.getByLabel('Include recorded images',{exact:true}).check();
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
}
export async function view(page:Page) {
  const button=page.getByRole('button',{name:'View recorded image',exact:true,includeHidden:true});
  if(!await button.isVisible())await page.locator('details').filter({has:button}).locator('summary').click();
  await button.click();
}
export async function show(page:Page) {
  await view(page);
  const canvas=page.getByRole('img',{name:'Recorded image preview',exact:true});
  await expect(canvas).toBeVisible();
  await canvas.evaluate(element=>{window.recordedImageFixture.canvas=element as HTMLCanvasElement;});
  return canvas;
}
export const counters=(page:Page)=>page.evaluate(()=>{
  const {calls,decodes,orientations,closed,urls,drafts}=window.recordedImageFixture;
  return {calls,decodes,orientations,closed,urls,drafts};
});
export async function expectCleared(page:Page) {
  await expect(page.getByRole('img',{name:'Recorded image preview',exact:true})).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>{
    const f=window.recordedImageFixture;
    return f.closed>0&&f.canvas?.width===0&&f.canvas.height===0;
  })).toBe(true);
}
export async function closeWithoutSideEffects(page:Page,external:string[]) {
  await page.getByRole('button',{name:'Close image preview',exact:true}).click();
  await expectCleared(page);
  expect(await counters(page)).toMatchObject({decodes:1,orientations:[{imageOrientation:'from-image'}],urls:0,drafts:0});
  expect(external).toEqual([]);
}
