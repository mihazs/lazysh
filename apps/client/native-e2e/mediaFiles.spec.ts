import {expect,it} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {MP3,WEBM} from '../../../tests/support/mediaFixtures';
import {mediaFrameDocument,mediaFramePolicy} from '../src/mediaFrameDocument';
import {openOwnedSsh,ownedSshGui,workspaceAction} from './sshUi';

const owned=ownedSshGui();
const LIMIT=8*1024*1024;
// What would run if the viewer treated a "video" as a page: it would reach for the window that holds the bridge.
const PAGE='<!doctype html><title>not a video</title><script>window.parent.mediaPageRan=1;window.top.mediaPageRan=1</script>';
const NO_PLAYER='This device cannot play video or audio inside the app. On Linux that needs GStreamer\'s audio plugins (gst-plugins-good, or gstreamer1.0-plugins-good). Use Open with or Download instead.';

type Elements=Awaited<ReturnType<NonNullable<NativeGui['browser']>['$']>>;
/** File names end in .webm, .mp3 and .pdf, which WebdriverIO would read as selectors, so match by XPath. */
const entry=(files:Elements,name:string)=>files.$(`.//button[contains(concat(" ",@class," ")," file-entry ")][./span[normalize-space(.)="${name}"]]`);

it('plays video and audio from a real SSH host in an isolated frame, and refuses a page, an oversized file and a PDF',async()=>{
  owned.captureSafe=false;
  const ssh=owned.ssh=await SshFixture.start(undefined,{companion:true,privateTtyGroup:true});
  const media=join(ssh.directory,'media');
  await mkdir(media);
  await Promise.all([['clip.webm',WEBM],['tune.mp3',MP3],['page.mp4',PAGE],['huge.webm',Buffer.concat([WEBM,Buffer.alloc(LIMIT)])],['manual.pdf','%PDF-1.4\n']]
    .map(([name,bytes])=>writeFile(join(media,name as string),bytes)));
  const gui=owned.gui=await NativeGui.start(),{browser,owner}=await openOwnedSsh(gui,ssh);
  owned.captureSafe=true;
  gui.stage='owned Files over SFTP';
  await workspaceAction(gui,'Files');
  const files=await browser.$('section[aria-label="Remote files"]');await files.waitForDisplayed({timeout:20_000});
  await entry(files,'media').click();
  for(const name of ['clip.webm','tune.mp3','page.mp4','huge.webm','manual.pdf'])await entry(files,name).waitForDisplayed({timeout:20_000});
  const alertText=async()=>(await browser.$$('section[aria-label="Remote files"] [role="alert"]'))[0]?.getText();
  /** A player frame, or the app's own refusal: WebKitGTK aborts its web process when GStreamer's audio sink is missing, so the app asks first. */
  async function outcome(file:string) {
    const frame=`iframe[title="Preview of ./media/${file}"]`;
    await entry(files,file).click();
    await browser.waitUntil(async()=>(await browser.$$(frame)).length>0||await alertText()!==undefined,{timeout:20_000,timeoutMsg:`${file} showed neither a player nor a refusal`});
    return (await browser.$$(frame)).length>0?frame:undefined;
  }

  /** A refusal waits for its own message: the previous file's alert is cleared when the next one is chosen. */
  async function refused(file:string,message:string) {
    await entry(files,file).click();
    await browser.waitUntil(async()=>await alertText()===message,{timeout:20_000,timeoutMsg:`${file} was not refused with its message`});
    expect(await browser.$$('iframe')).toHaveLength(0);
  }

  gui.stage='owned Files video';
  const video=await outcome('clip.webm');
  console.info(`Owned Files media: ${video?'player frame':'no-player refusal'}`);
  if(video) {
    // The page sees an empty sandbox, no way into the frame, and the exact bytes SFTP read inside the frame's own document.
    expect(await browser.execute(selector=>{
      const frame=document.querySelector<HTMLIFrameElement>(selector)!;
      return {sandbox:frame.getAttribute('sandbox'),src:frame.hasAttribute('src'),document:(()=>{try{return typeof frame.contentDocument?.title;}catch{return 'blocked';}})(),
        player:new DOMParser().parseFromString(frame.srcdoc,'text/html').querySelector('video')?.getAttribute('src')};
    },video)).toEqual({sandbox:'',src:false,document:'undefined',player:`data:video/webm;base64,${WEBM.toString('base64')}`});
  } else expect(await alertText()).toBe(NO_PLAYER);
  expect(await browser.$$('iframe')).toHaveLength(video?1:0);

  gui.stage='owned Files audio';
  const audio=await outcome('tune.mp3');
  if(audio)expect(await browser.execute(selector=>new DOMParser().parseFromString(document.querySelector<HTMLIFrameElement>(selector)!.srcdoc,'text/html').querySelector('audio')?.getAttribute('src')?.startsWith('data:audio/mpeg;base64,'),audio)).toBe(true);
  else expect(await alertText()).toBe(NO_PLAYER);
  expect(await browser.$$('iframe')).toHaveLength(audio?1:0);

  gui.stage='owned Files refuses a page named like a video';
  await refused('page.mp4','This file is not the video or audio its name says, so it was not played. Use Open with or Download to handle it yourself.');

  gui.stage='owned Files refuses an oversized video';
  await refused('huge.webm','Video and audio previews are limited to 8 MiB. Use Open with or Download for larger files.');

  gui.stage='owned Files leaves a PDF to the device viewer';
  await entry(files,'manual.pdf').click();
  await browser.waitUntil(()=>browser.execute(()=>document.querySelector('.file-preview .file-note')?.textContent?.startsWith('PDF files are not drawn inside the app')),{timeout:20_000,timeoutMsg:'The PDF note was not shown'});
  expect(await browser.$$('iframe')).toHaveLength(0);

  // The frame's isolation does not depend on codecs: the same sandbox and document, minus the media element, in the real window and policy.
  gui.stage='owned frame isolation';
  await browser.execute(document_=>{
    const frame=document.createElement('iframe');
    frame.id='isolation-probe';frame.setAttribute('sandbox','');frame.setAttribute('referrerpolicy','no-referrer');
    frame.srcdoc=document_;document.body.append(frame);
  },mediaFrameDocument({kind:'video',mime:'video/webm',data:''}).replace(/<video.*<\/video>/,'<p id="probe">inside</p>'));
  await browser.switchFrame(await browser.$('#isolation-probe'));
  const inside=await browser.execute(()=>({text:document.getElementById('probe')?.textContent,origin:location.origin,bridge:'__TAURI_INTERNALS__' in window,
    parent:(()=>{try{return typeof window.parent.document.title;}catch{return 'blocked';}})(),
    policy:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),scripts:document.scripts.length}));
  await browser.switchFrame(null);
  expect(inside).toEqual({text:'inside',origin:'null',bridge:false,parent:'blocked',policy:mediaFramePolicy,scripts:0});
  expect(await browser.execute(()=>{const frame=document.querySelector<HTMLIFrameElement>('#isolation-probe')!;
    try{return typeof frame.contentDocument?.title;}catch{return 'blocked';}})).toBe('undefined');

  // Nothing from any file reached the window that holds the bridge.
  expect(await browser.execute(()=>typeof (window as unknown as {mediaPageRan?:number}).mediaPageRan)).toBe('undefined');
  expect(await gui.appOwner()).toEqual(owner);
});
