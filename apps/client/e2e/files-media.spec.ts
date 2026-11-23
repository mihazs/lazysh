import {expect,test,type Frame,type Page} from '@playwright/test';
import type {mountFilesMedia} from './fixtures/FilesMediaHarness';
import {MP3,WEBM} from '../../../tests/support/mediaFixtures';
declare global {interface Window {media:ReturnType<typeof mountFilesMedia>;}}

async function open(page:Page) {
  await page.goto('/');
  await page.evaluate(async files=>{
    const {mountFilesMedia}=await import('/e2e/fixtures/FilesMediaHarness.tsx');
    window.media=mountFilesMedia(files);
  },{webm:WEBM.toString('base64'),mp3:MP3.toString('base64')});
  return page.getByRole('region',{name:'Remote files',exact:true});
}
/** The only child frame: Playwright reads it through the debugger, which the frame's own sandbox does not bind. */
const player=(page:Page):Frame=>page.frames().find(frame=>frame!==page.mainFrame())!;

test('a video and an audio file play in a frame with an opaque origin that holds no bridge and runs no script',async({page})=>{
  const files=await open(page);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await files.getByRole('button',{name:/clip\.webm/}).click();
  const frame=page.locator('iframe[title="Preview of ./clip.webm"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox','');
  // The engine decodes the bytes: the sniffed WebM is a 16x16 video of 0.4 s.
  await expect.poll(()=>player(page).evaluate(()=>{const video=document.querySelector('video')!;return [video.readyState>=1,video.videoWidth,video.videoHeight,Math.round(video.duration*10)];})).toEqual([true,16,16,4]);
  expect(await player(page).evaluate(()=>({origin:location.origin,bridge:'__TAURI_INTERNALS__' in window,
    parent:(()=>{try{return typeof window.parent.document.title;}catch{return 'blocked';}})(),
    scripts:document.querySelectorAll('script').length,csp:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')})))
    .toEqual({origin:'null',bridge:false,parent:'blocked',scripts:0,csp:"default-src 'none'; media-src data:; style-src 'unsafe-inline'"});
  // The window that holds the bridge cannot reach into the frame either.
  expect(await page.evaluate(()=>{try{return typeof document.querySelector('iframe')!.contentDocument?.title;}catch{return 'blocked';}})).toBe('undefined');
  const box=await frame.boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  await page.screenshot({path:test.info().outputPath('media-video.png')});

  await files.getByRole('button',{name:/tune\.mp3/}).click();
  await expect(page.locator('iframe[title="Preview of ./tune.mp3"]')).toBeVisible();
  await expect.poll(()=>player(page).evaluate(()=>{const audio=document.querySelector('audio')!;return [audio.readyState>=1,audio.duration>0.1&&audio.duration<0.5];})).toEqual([true,true]);
  await expect(page.locator('iframe')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a file whose bytes are not the media its name says is refused with a message and no frame',async({page})=>{
  const files=await open(page);
  await files.getByRole('button',{name:/fake\.mp3/}).click();
  await expect(files.getByRole('alert')).toHaveText('This file is not the video or audio its name says, so it was not played. Use Open with or Download to handle it yourself.');
  await expect(page.locator('iframe')).toHaveCount(0);
});
