import {writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acquireDevice,APP_PACKAGE,type DeviceSession} from '../../apps/client/mobile-e2e/support/device';

/**
 * Driving a real Android device for the edge-gesture regressions (#1380, #1435): navigation overlays, injected touches, the system's own
 * gesture state from dumpsys and the app's state through its WebView (Chrome DevTools over `adb forward`). Device state is the business of
 * the Appium suite's `support/device.ts` (`acquireDevice`): the per-serial advisory lock, the journal and the baseline it restores, because the
 * local Waydroid guest is shared and UiAutomator sessions kill each other. This file adds only what that suite does not do.
 */
export const appId=APP_PACKAGE;
export const overlayCategory='com.android.internal.systemui.navbar.';
export type Overlay='threebutton'|'gestural_wide_back'|'gestural_extra_wide_back';
export const overlays:readonly Overlay[]=['threebutton','gestural_wide_back','gestural_extra_wide_back'];
const navigationMode:Record<Overlay,number>={threebutton:0,gestural_wide_back:2,gestural_extra_wide_back:2};

export const sdkRoot=process.env.ANDROID_HOME??process.env.ANDROID_SDK_ROOT??join(homedir(),'.cache/lazysh-display-422-sdk');
/** Read at each call, so a controlled test can point it at a fake adb. */
export const adbPath=()=>process.env.LAZYSH_ADB??join(sdkRoot,'platform-tools/adb');
export const defaultSerial=process.env.ANDROID_SERIAL??'192.168.240.112:5555';

async function run(args:string[],timeoutMs=60_000,input?:string) {
  const child=Bun.spawn(args,{stdout:'pipe',stderr:'pipe',stdin:input===undefined?'ignore':new TextEncoder().encode(input)});
  const timer=setTimeout(()=>child.kill(),timeoutMs);
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  clearTimeout(timer);
  if(code!==0)throw new Error(`adb ${args.slice(1).join(' ')} exited ${code}: ${err.trim().slice(0,300)}`);
  return out;
}

export class Device {
  private session?:DeviceSession;
  readonly forwards=new Set<number>();
  readonly reverses=new Set<number>();
  constructor(readonly serial=defaultSerial) {}

  /** A network serial drops when Android recreates its services (a navigation overlay switch): reconnect once and retry. */
  async adb(args:string[],timeoutMs?:number,input?:string) {
    try {return await run([adbPath(),'-s',this.serial,...args],timeoutMs,input);}
    catch(error) {
      if(!this.serial.includes(':')||!/offline|not found|unauthorized|closed|connection reset/i.test((error as Error).message))throw error;
      await run([adbPath(),'connect',this.serial],20_000).catch(()=>{});await delay(1000);
      return run([adbPath(),'-s',this.serial,...args],timeoutMs,input);
    }
  }
  shell(command:string,timeoutMs?:number) {return this.adb(['shell',command],timeoutMs);}

  /** Queues for the advisory lock, then records the baseline. Always pair with {@link release}. LAZYSH_E2E_RECOVER=1 restores a journal a dead run left. */
  async acquire(timeoutMs=600_000,stateDir?:string) {
    this.session=await acquireDevice(this.serial,{stateDir,lockTimeoutMs:timeoutMs,recover:process.env.LAZYSH_E2E_RECOVER==='1',adb:(...args)=>this.adb(args),log:console.error});
  }

  /** Removes this run's forwards and reverses, then restores the baseline and releases the lock, each step even when another failed. */
  async release() {
    const failures:string[]=[];
    const attempt=async(what:string,work:()=>Promise<unknown>)=>{try{await work();}catch(error){failures.push(`${what}: ${(error as Error).message}`);}};
    for(const port of this.forwards)await attempt(`forward ${port}`,()=>this.adb(['forward','--remove',`tcp:${port}`]));
    for(const port of this.reverses)await attempt(`reverse ${port}`,()=>this.adb(['reverse','--remove',`tcp:${port}`]));
    await attempt('baseline',async()=>{await this.session?.release();this.session=undefined;});
    if(failures.length)throw new Error(`Device restore incomplete: ${failures.join('; ')}`);
  }

  async hasOverlay(name:Overlay) {return (await this.shell('cmd overlay list --user 0 android')).split('\n').some(line=>line.trim().endsWith(overlayCategory+name));}
  navigationMode=async()=>Number((await this.shell('settings get secure navigation_mode')).trim());

  async useNavigation(name:Overlay) {
    await this.shell(`cmd overlay enable-exclusive --user 0 --category ${overlayCategory}${name}`);
    for(let attempt=0;attempt<100;attempt++) {
      if(await this.navigationMode()===navigationMode[name])return;
      await delay(200);
    }
    throw new Error(`navigation_mode never became ${navigationMode[name]} for ${name}`);
  }

  /** A 1080 x 2340 px phone at 420 dpi (411 x 891 dp), the reference geometry of the gesture work. */
  async phone(height=2340) {await this.shell(`wm size 1080x${height}`);await this.shell('wm density 420');}
  /** One real DOWN, 8 ms MOVEs, UP, as `input` injects them; the system gesture monitors see it as they would a finger. */
  swipe(from:[number,number],to:[number,number],durationMs=200) {return this.shell(`input touchscreen swipe ${from[0]} ${from[1]} ${to[0]} ${to[1]} ${durationMs}`);}
  back() {return this.shell('input keyevent KEYCODE_BACK');}
  /** Hides the soft keyboard the terminal's focus raised; the first Back is the keyboard's and leaves the app alone. */
  async hideKeyboard() {
    for(let attempt=0;attempt<5;attempt++) {
      if(!/mInputShown=true/.test(await this.shell('dumpsys input_method'))) return;
      await this.back();await delay(600);
    }
    throw new Error('The soft keyboard did not close');
  }
  /** A PNG of the screen, for the failure message of a case that timed out. */
  async screenshot(directory=tmpdir()) {
    const path=join(directory,`lazysh-gesture-failure-${Date.now()}.png`);
    const child=Bun.spawn([adbPath(),'-s',this.serial,'exec-out','screencap','-p'],{stdout:'pipe',stderr:'ignore'});
    await writeFile(path,Buffer.from(await new Response(child.stdout).arrayBuffer())).catch(()=>{});
    return path;
  }
  async foreground() {return /topResumedActivity=ActivityRecord\{\S+ \S+ ([^\s}]+)/.exec(await this.shell('dumpsys activity activities'))?.[1]??'';}
  async appPid() {return Number((await this.shell(`pidof ${appId}`).catch(()=>'')).trim().split(/\s+/)[0])||0;}

  /** What the system's own back-gesture handler uses right now: zone widths and heights in px, the exclusion regions it honours and was asked for. */
  async edgeBack() {return parseEdgeBack(await this.shell('dumpsys activity service com.android.systemui/.SystemUIService',90_000));}
}

/** The `EdgeBackGestureHandler:` block of `dumpsys activity service com.android.systemui/.SystemUIService`. */
export function parseEdgeBack(dump:string) {
  const section=dump.slice(dump.lastIndexOf('EdgeBackGestureHandler:'));
  const number=(name:string)=>Number(new RegExp(`${name}=([\\d.]+)`).exec(section)?.[1]??NaN);
  const region=(name:string)=>new RegExp(`${name}=(SkRegion\\([^\\n]*\\))`).exec(section)?.[1]??'';
  return {gestural:/mIsGesturalModeEnabled=true/.test(section),left:number('mEdgeWidthLeft'),right:number('mEdgeWidthRight'),bottom:number('mBottomGestureHeight'),
    excludeRegion:region('mExcludeRegion'),unrestrictedRegion:region('mUnrestrictedExcludeRegion')};
}

/** A page of the app's WebView over Chrome DevTools: one evaluate, no other protocol surface. */
export class Page {
  private next=0;
  /** A page whose context is gone never answers; a live one answers in milliseconds. */
  answerMs=30_000;
  private pending=new Map<number,(value:any)=>void>();
  private constructor(private readonly socket:WebSocket,readonly port:number,readonly pid:number) {
    socket.onmessage=event=>{const message=JSON.parse(String(event.data));this.pending.get(message.id)?.(message);this.pending.delete(message.id);};
  }
  static async attach(device:Device,timeoutMs=180_000) {
    const deadline=Date.now()+timeoutMs;
    for(;;) {
      const pid=await device.appPid();
      if(pid) {
        const port=Number((await device.adb(['forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`])).trim());
        device.forwards.add(port);
        try {
          const pages=await (await fetch(`http://127.0.0.1:${port}/json`)).json() as {type:string;url:string;webSocketDebuggerUrl:string}[];
          // A recreated activity leaves its destroyed WebView listed for a moment: take the newest page that still answers.
          for(const target of pages.filter(page=>page.type==='page'&&page.url.includes('tauri.localhost')).reverse()) {
            const socket=new WebSocket(target.webSocketDebuggerUrl);
            const opened=await new Promise<boolean>(resolve=>{socket.onopen=()=>resolve(true);socket.onerror=()=>resolve(false);});
            if(process.env.LAZYSH_GESTURE_DEBUG)console.error(`attach: ${target.url} opened=${opened} pid=${pid}`);
            if(!opened)continue;
            const page=new Page(socket,port,pid);
            page.answerMs=10_000;
            // A destroyed WebView still answers for a while but is hidden: only the page the user sees counts.
            if(await page.evaluate<boolean>(`document.visibilityState==='visible'`).then(value=>value===true,error=>{if(process.env.LAZYSH_GESTURE_DEBUG)console.error(`attach probe: ${(error as Error).message}`);return false;})){page.answerMs=30_000;return page;}
            socket.close();
          }
        } catch {/* the WebView is still starting */}
        await device.adb(['forward','--remove',`tcp:${port}`]).catch(()=>{});device.forwards.delete(port);
      }
      if(Date.now()>=deadline)throw new Error(`The app WebView never exposed a page (pid ${pid}, foreground ${await device.foreground().catch(()=>'?')}, log: ${(await device.shell('logcat -d -t 800 -v time').catch(()=>'')).split('\n').filter(line=>/FATAL|AndroidRuntime|Process app\.lazysh\.client|died|ANR in app\.lazysh/.test(line)).slice(-6).join(' | ')})`);
      await delay(500);
    }
  }
  async evaluate<T=unknown>(expression:string):Promise<T> {
    const id=++this.next;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const answer=new Promise<any>((resolve,reject)=>{this.pending.set(id,resolve);timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Runtime.evaluate timed out'));},this.answerMs);});
    try {
      this.socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
      const message=await answer;
      if(message.error||message.result?.exceptionDetails)throw new Error(`page error: ${JSON.stringify(message.error??message.result.exceptionDetails.exception?.description??'').slice(0,300)}`);
      return message.result.result.value as T;
    } finally {clearTimeout(timer);}
  }
  async until(what:string,expression:string,timeoutMs=30_000) {
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline) {
      if(await this.evaluate<boolean>(`Boolean(${expression})`).catch(()=>false))return;
      await delay(150);
    }
    const text=await this.evaluate<string>(`document.body.innerText.replace(/\\s+/g,' ').slice(0,300)`).catch(()=>'(the page does not answer)');
    throw new Error(`Timed out waiting for ${what}; the page shows: ${text}`);
  }
  close() {this.socket.close();}
}

/** What the page can say about the gesture state, in one round trip. */
export type View={sidebar:boolean;bottomMenu:boolean;agentView:boolean;insets:{left:number;right:number;bottom:number;mandatoryBottom:number;navigation:string}|null;touches:string[]};
export const readView=(page:Page)=>page.evaluate<View>(`(async()=>({
  sidebar:document.querySelector('.sidebar')?.classList.contains('sidebar-open')??false,
  bottomMenu:getComputedStyle(document.querySelector('.bottom-menu')??document.body).visibility!=='hidden'&&document.querySelector('.bottom-menu')?.getAttribute('data-open')==='true',
  agentView:[...document.querySelectorAll('[aria-label="Agent view"]')].some(node=>node.getClientRects().length>0),
  insets:await Promise.race([new Promise(resolve=>setTimeout(()=>resolve(null),5000)),
    window.__TAURI_INTERNALS__.invoke('app_lock_status').then(status=>window.__TAURI_INTERNALS__.invoke('edge_gesture_insets',{},{headers:{'X-Lazysh-Access':status.nonce??''}})).catch(()=>null)]),
  touches:window.__gestureTouches??[],
}))()`);
/** Records every touch the page receives, so "the system took it" (a touchcancel, or no touch at all) is observable. */
export const recordTouches=(page:Page)=>page.evaluate(`(()=>{if(window.__gestureTouchesInstalled)return true;window.__gestureTouchesInstalled=true;window.__gestureTouches=[];
  for(const type of ['touchstart','touchend','touchcancel'])window.addEventListener(type,event=>window.__gestureTouches.push(type+':'+Math.round((event.changedTouches[0]||{}).clientX)+','+Math.round((event.changedTouches[0]||{}).clientY)),{capture:true,passive:true});return true;})()`);
export const clearTouches=(page:Page)=>page.evaluate('window.__gestureTouches=[];true');

/** Deterministic timing jitter, so a failing run can be replayed. */
export function jitter(seed=1435) {
  let state=seed;
  return (maxMs:number)=>{state=(state*1664525+1013904223)>>>0;return state%(maxMs+1);};
}

/** The owned SSH host a session connects to; `SshFixture` satisfies it. */
export type OwnedHost={port:number;username:string;privateKey:string;fingerprint:string;prompt:string;nonce:string};
const helpers=`window.__lz=window.__lz||{
  set(element,value){const proto=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));return true;},
  button(text){return [...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===text||(!button.getAttribute('aria-label')&&button.textContent.trim()===text));},
  click(text){const button=this.button(text);if(!button)throw new Error('no button '+text);button.click();return true;},
};true`;
const quote=JSON.stringify;

/**
 * Connects the app to an owned SSH fixture through its real UI: add the host once, choose the private key, trust the pinned host key and wait
 * for the shell prompt. The guest reaches the fixture on 127.0.0.1 through `adb reverse`. Safe to call on a page that is already connected.
 */
export async function connectOwnedSession(page:Page,host:OwnedHost) {
  const name=`Android SSH ${host.nonce}`;
  await page.until('the start page',`window.__TAURI_INTERNALS__?.invoke && document.querySelector("button[aria-label='Add host'], .terminal-canvas .xterm-screen")`,180_000);
  await page.evaluate(helpers);
  if(await page.evaluate<boolean>(`Boolean(document.querySelector('.terminal-canvas .xterm-screen'))`))return;
  if(!await page.evaluate<boolean>(`Boolean(document.querySelector("button[aria-label='Connect to ${name}']"))`)) {
    await page.evaluate(`window.__lz.click('Add host')`);
    await page.until('the host editor','document.querySelector("input[placeholder=\'Home workstation\']")');
    await page.evaluate(`(()=>{const set=(selector,value)=>window.__lz.set(document.querySelector(selector),value);
      set("input[placeholder='Home workstation']",${quote(name)});set("input[placeholder='workstation.local']",'127.0.0.1');
      set("input[placeholder='Your SSH username']",${quote(host.username)});set('.port-field input',${quote(String(host.port))});return true;})()`);
    await page.evaluate(`window.__lz.click('Save host')`);
    await page.until('the saved host',`document.querySelector("button[aria-label='Connect to ${name}']")`);
  }
  await page.evaluate(`document.querySelector("button[aria-label='Connect to ${name}']").click()`);
  await page.until('the authentication dialog','document.querySelector("[role=dialog] input[type=password]")');
  await page.evaluate(`window.__lz.click('Private key')`);
  await page.until('the key field','document.querySelector("[role=dialog] textarea[placeholder=\'-----BEGIN OPENSSH PRIVATE KEY-----\']")');
  await page.evaluate(`window.__lz.set(document.querySelector("[role=dialog] textarea[placeholder='-----BEGIN OPENSSH PRIVATE KEY-----']"),${quote(host.privateKey)})`);
  await page.evaluate(`window.__lz.click('Connect')`);
  // The host key is reviewed on the first connection only.
  await page.until('the host key review or the prompt',`document.querySelector('.fingerprint code') || [...document.querySelectorAll('.terminal-canvas .xterm-screen')].some(screen=>screen.textContent.includes(${quote(host.prompt)}))`,60_000);
  if(await page.evaluate<boolean>(`Boolean(document.querySelector('.fingerprint code'))`)) {
    if(await page.evaluate<string>(`document.querySelector('.fingerprint code').textContent`)!==host.fingerprint)throw new Error('The app showed another host key than the owned fixture');
    await page.evaluate(`window.__lz.click('Trust key and connect')`);
  }
  await page.until('the shell prompt',`[...document.querySelectorAll('.terminal-canvas .xterm-screen')].some(screen=>screen.textContent.includes(${quote(host.prompt)}))`,60_000);
  // The password dialog's typing leaves a guard window in which no gesture starts.
  await delay(1500);
}
