import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SshFixture} from './support/sshFixture';
import {appId,clearTouches,connectOwnedSession,Device,jitter,overlays,Page,parseEdgeBack,readView,recordTouches,type Overlay,type View} from './support/androidGestures';

/** A fake `adb` that records every call and keeps the navigation overlay in a file, so the harness is tested without a device. */
async function fakeAdb(directory:string,overlay='gestural_wide_back') {
  const script=join(directory,'adb'),state=join(directory,'overlay'),log=join(directory,'calls.log');
  await writeFile(state,overlay);
  await writeFile(script,`#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *"cmd overlay list"*) echo "android"; echo "[x] ${'${CATEGORY}'}$(cat "${state}")"; echo "[ ] ${'${CATEGORY}'}threebutton" ;;
  *"cmd overlay enable-exclusive"*) basename_="$(printf '%s' "$*" | sed 's/.*navbar\\.//')"; printf '%s' "$basename_" > "${state}" ;;
  *"settings get secure navigation_mode"*) [ "$(cat "${state}")" = threebutton ] && echo 0 || echo 2 ;;
esac
`.replace(/\$\{CATEGORY\}/g,'com.android.internal.systemui.navbar.'));
  await chmod(script,0o700);
  return {script,log,calls:async()=>(await readFile(log,'utf8')).trim().split('\n')};
}

describe('the device harness, against a fake adb',()=>{
  test('restores the navigation overlay it found and removes its forwards and reverses, even when the body throws',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'lazysh-gestures-'));
    const fake=await fakeAdb(directory);
    process.env.LAZYSH_ADB=fake.script;
    const device=new Device('fake-restore-serial');
    try {
      await device.acquire(2000,directory);
      device.forwards.add(39001);device.reverses.add(39002);
      await expect((async()=>{
        try {await device.useNavigation('threebutton');throw new Error('the case failed');}
        finally {await device.release();}
      })()).rejects.toThrow('the case failed');
      const calls=await fake.calls();
      expect(calls).toContain('-s fake-restore-serial forward --remove tcp:39001');
      expect(calls).toContain('-s fake-restore-serial reverse --remove tcp:39002');
      expect(calls.filter(call=>call.includes('cmd overlay enable-exclusive')).at(-1)).toContain('navbar.gestural_wide_back');
    } finally {delete process.env.LAZYSH_ADB;await rm(directory,{recursive:true,force:true});}
  });

  test('reads the zones, the exclusion regions and the gesture mode from the system dump',()=>{
    const dump=`    EdgeBackGestureHandler:
      mIsEnabled=true
      mIsGesturalModeEnabled=true
      mEdgeWidthLeft=84
      mEdgeWidthRight=105
      mBottomGestureHeight=84.0
      mExcludeRegion=SkRegion((0,1478,63,2003)(1017,1478,1080,2003))
      mUnrestrictedExcludeRegion=SkRegion()
      mIsInPip=false`;
    expect(parseEdgeBack(dump)).toEqual({gestural:true,left:84,right:105,bottom:84,excludeRegion:'SkRegion((0,1478,63,2003)(1017,1478,1080,2003))',unrestrictedRegion:'SkRegion()'});
    expect(parseEdgeBack('EdgeBackGestureHandler:\n      mIsGesturalModeEnabled=false\n      mExcludeRegion=SkRegion()').gestural).toBe(false);
  });

  test('timing jitter is deterministic for a seed and stays inside its bound',()=>{
    const first=jitter(7),second=jitter(7),values=Array.from({length:50},()=>first(120));
    expect(values).toEqual(Array.from({length:50},()=>second(120)));
    expect(values.every(value=>value>=0&&value<=120)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(10);
  });
});

/**
 * #1380 (the edge gestures conflict with Android's navigation gestures) and #1435 (the first Back after a swipe-opened page left the app;
 * one left-edge swipe missed) on a real Android runtime: for each navigation overlay the real system gesture zones, real injected swipes
 * (`adb shell input touchscreen swipe`) from the screen edge, inside the system zone, in the band, at its end and beyond it, the system's
 * own state (dumpsys: EdgeBackGestureHandler, foreground activity) and the app's state through its WebView.
 *
 * Runs only with LAZYSH_ANDROID_GESTURES=1 against a device whose navigation overlays can be switched (the local Waydroid guest, or an
 * emulator image that carries them); an overlay the device lacks is skipped and reported. The navigation overlay, window size and density,
 * rotation lock, adb forwards and reverses are restored in afterAll even when a case fails.
 *   LAZYSH_GESTURE_REPS (default 10) tries per position, LAZYSH_GESTURE_CYCLES (default 100) open/Back cycles and band swipes, LAZYSH_GESTURE_SWIPES (default 100) left-band swipes, LAZYSH_DEVICE_WAIT_MS (default 10 minutes) how long to queue for the device.
 */
const enabled=process.env.LAZYSH_ANDROID_GESTURES==='1';
const repetitions=Number(process.env.LAZYSH_GESTURE_REPS??10),cycles=Number(process.env.LAZYSH_GESTURE_CYCLES??100),swipeRuns=Number(process.env.LAZYSH_GESTURE_SWIPES??100);
const apk=process.env.LAZYSH_ANDROID_APK??join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');
/** How long to queue for the device lock, which the Appium suite takes for whole runs. */
const deviceWaitMs=Number(process.env.LAZYSH_DEVICE_WAIT_MS??600_000);
const density=420/160,screen={width:1080,height:2340};
const bandWidth=40,margin=4;
const launch=`am start -n ${appId}/.MainActivity`;

type Edge='left'|'right'|'bottom';
type Expectation='opens'|'system'|'nothing';
type Geometry={offsetX:number;offsetY:number;width:number;height:number};

describe.skipIf(!enabled)('edge gestures against the real Android navigation (#1380, #1435)',()=>{
  const device=new Device();
  let fixture:SshFixture|undefined,page:Page|undefined,calibration:Geometry|undefined,installedBefore=false;
  const available:Overlay[]=[],skipped:string[]=[];

  beforeAll(async()=>{
    await device.acquire(deviceWaitMs);
    for(const overlay of overlays)(await device.hasOverlay(overlay)?available:skipped).push(overlay);
    if(!existsSync(apk))throw new Error(`Build the x86_64 debug APK first (bun run build:android:emulator); missing ${apk}`);
    installedBefore=(await device.shell(`pm list packages ${appId}`)).includes(`package:${appId}`);
    await device.adb(['install','-r','-t','-d',apk],180_000);
    await device.shell(`pm grant ${appId} android.permission.POST_NOTIFICATIONS`).catch(()=>{});
    await device.phone();
    fixture=await SshFixture.start();
    await device.adb(['reverse',`tcp:${fixture.port}`,`tcp:${fixture.port}`]);
    device.reverses.add(fixture.port);
  },deviceWaitMs+600_000);

  afterAll(async()=>{
    page?.close();
    await device.shell(`am force-stop ${appId}`).catch(()=>{});
    // Uninstalled, not cleared (`pm clear` leaves the Keystore alias of the vault orphaned and the next launch never becomes visible), unless
    // the device had the app already: its permission baseline is restored on release and needs the package.
    if(!installedBefore)await device.adb(['uninstall',appId]).catch(()=>{});
    await fixture?.stop().catch(()=>{});
    await device.release();
  },120_000);

  /** The system recreates the activity of every app when the navigation overlay changes: the page of the old one must not be reused. */
  async function switchTo(overlay:Overlay) {
    await device.useNavigation(overlay);
    page?.close();page=undefined;
  }

  /** A process that is up but never shows its WebView (seen once in about ten cold starts on the guest) gets one clean restart. */
  async function attachOrRestart() {
    try {return await Page.attach(device,90_000);}
    catch(error) {
      console.error(`restarting the app: ${(error as Error).message}`);
      await device.shell(`am force-stop ${appId}`);await delay(1000);await device.shell(launch);
      return Page.attach(device,120_000);
    }
  }

  /** The app in front, its page attached, a session connected and the page recording touches. */
  async function session() {
    await device.shell(launch);
    if(page&&page.pid!==await device.appPid()){page.close();page=undefined;}
    page??=await attachOrRestart();
    try {await page.evaluate('true');} catch {page.close();page=await attachOrRestart();}
    await connectOwnedSession(page,fixture!);
    // A live remote connection opens the navigation page on Agents; the terminal is behind it.
    await device.hideKeyboard();
    await closeEverything(page);
    await recordTouches(page);
    calibration=await calibrate(page);
    // The calibration tap focuses the terminal and raises the keyboard, which would cover the bottom edge: close it and measure the viewport without it.
    await device.hideKeyboard();
    // A focused terminal input raises the keyboard again when a page opens over it, and then the first Back is the keyboard's, as on any Android app: blur it.
    await page.evaluate('document.activeElement?.blur?.();true');
    await delay(500);
    const [width,height]=await page.evaluate<number[]>('[window.innerWidth,window.innerHeight]');
    calibration={...calibration,width,height};
    return page;
  }
  /** One tap at a known device pixel tells where the viewport sits on the screen (the system bars pad it). */
  async function calibrate(current:Page):Promise<Geometry> {
    await clearTouches(current);
    await device.shell('input touchscreen tap 540 1200');
    await current.until('the calibration tap',`window.__gestureTouches.some(touch=>touch.startsWith('touchstart:'))`,10_000)
      .catch(async error=>{throw new Error(`${error.message}; touches=${JSON.stringify(await current.evaluate('window.__gestureTouches').catch(()=>null))} focus=${(await device.shell('dumpsys window | grep mCurrentFocus')).trim()} text=${(await current.evaluate<string>('document.body.innerText.slice(0,200)').catch(()=>'')).replace(/\\n/g,' | ')} screenshot=${await device.screenshot()}`);});
    const [x,y]=(await current.evaluate<string[]>('window.__gestureTouches')).find(touch=>touch.startsWith('touchstart:'))!.slice('touchstart:'.length).split(',').map(Number);
    const [width,height]=await current.evaluate<number[]>('[window.innerWidth,window.innerHeight]');
    return {offsetX:540-x*density,offsetY:1200-y*density,width,height};
  }
  const closeEverything=async(current:Page)=>{
    for(let attempt=0;attempt<4;attempt++) {
      const view=await readView(current);
      if(!view.sidebar&&!view.bottomMenu&&!view.agentView)return;
      await device.back();await delay(700);
    }
    throw new Error('Back did not close the open page');
  };

  /** A touch `distance` dp from `edge` (at least one pixel inside the screen), and the finger's way inward. */
  function stroke(edge:Edge,distanceDp:number,geometry:Geometry):{from:[number,number];to:[number,number]} {
    const px=Math.max(1,Math.round(distanceDp*density));
    const row=Math.round(geometry.offsetY+geometry.height*density*0.35);
    if(edge==='left')return {from:[px,row],to:[px+320,row+4]};
    if(edge==='right')return {from:[screen.width-px,row],to:[screen.width-px-320,row+4]};
    const viewportBottom=Math.round(geometry.offsetY+geometry.height*density);
    return {from:[200,viewportBottom-px],to:[204,viewportBottom-px-720]};
  }
  const opened=(view:View,edge:Edge)=>edge==='left'?view.sidebar:edge==='right'?view.agentView:view.bottomMenu;

  /** The positions the matrix tries on an edge, in dp from that edge, with what must happen. */
  function positions(view:View,edge:Edge):{name:string;distance:number;expect:Expectation}[] {
    const insets=view.insets!,system=edge==='bottom'?Math.max(insets.bottom,insets.mandatoryBottom):insets[edge==='left'?'left':'right'];
    if(insets.navigation!=='gesture') {
      return [{name:'the screen edge',distance:0,expect:'opens'},{name:'the start of the band',distance:2,expect:'opens'},{name:'the end of the band',distance:bandWidth-2,expect:'opens'},{name:'beyond the band',distance:bandWidth+10,expect:'nothing'}];
    }
    const start=system+margin;
    return [
      {name:'the screen edge',distance:0,expect:'system'},{name:'inside the system zone',distance:system/2,expect:'system'},
      {name:'the start of the band',distance:start+2,expect:'opens'},{name:'the middle of the band',distance:start+bandWidth/2,expect:'opens'},
      {name:'the end of the band',distance:start+bandWidth-2,expect:'opens'},{name:'beyond the band',distance:start+bandWidth+10,expect:'nothing'},
    ];
  }

  test('the shell reads the same gesture zones the system uses, under every overlay',async()=>{
    expect(available.length+skipped.length).toBe(overlays.length);
    for(const overlay of available) {
      await switchTo(overlay);
      const current=await session();
      const view=await readView(current),system=await device.edgeBack();
      expect(view.insets,overlay).not.toBeNull();
      if(overlay==='threebutton') {
        expect(system.gestural,overlay).toBe(false);
        expect(view.insets).toEqual({left:0,right:0,bottom:0,mandatoryBottom:0,navigation:'buttons'});
        continue;
      }
      expect(system.gestural,overlay).toBe(true);
      expect(view.insets!.navigation).toBe('gesture');
      // The side zones are the system's own back-gesture widths (px), to the dp.
      expect(Math.abs(view.insets!.left-Math.ceil(system.left/density)),`${overlay} left`).toBeLessThanOrEqual(2);
      expect(Math.abs(view.insets!.right-Math.ceil(system.right/density)),`${overlay} right`).toBeLessThanOrEqual(2);
      // The shell counts the Home zone from where the system bars' padding ends, so that padding plus the zone must reach the strip the system keeps for Home.
      const padding=screen.height-(calibration!.offsetY+calibration!.height*density);
      expect(view.insets!.bottom*density+padding,`${overlay} bottom`).toBeGreaterThanOrEqual(system.bottom-1);
      expect(view.insets!.mandatoryBottom,`${overlay} mandatory bottom`).toBeGreaterThan(0);
    }
  },600_000);

  test('a wider back sensitivity gives a wider system zone and the shell follows it without a setting changing',async()=>{
    if(!available.includes('gestural_wide_back')||!available.includes('gestural_extra_wide_back'))return;
    const widths:number[]=[];
    for(const overlay of ['gestural_wide_back','gestural_extra_wide_back'] as const) {
      await switchTo(overlay);
      const current=await session();
      widths.push((await readView(current)).insets!.left);
    }
    expect(widths[1]).toBeGreaterThan(widths[0]);
  },300_000);

  for(const overlay of overlays)test(`${overlay}: a swipe from the edge, the system zone, the band and beyond it does what the system and the band say, ${repetitions} times each`,async()=>{
    if(!available.includes(overlay))return;
    await switchTo(overlay);
    const current=await session(),geometry=calibration!;
    const view=await readView(current),tally:Record<string,number>={};
    for(const edge of ['left','right','bottom'] as const) {
      for(const position of positions(view,edge)) {
        // The Home zone belongs to the launcher: a swipe up from it leaves the app, so it is tried a few times and the app is brought back.
        const tries=edge==='bottom'&&position.expect==='system'?Math.min(3,repetitions):repetitions;
        for(let attempt=1;attempt<=tries;attempt++) {
          const label=`${overlay} ${edge} ${position.name} (${position.distance} dp) try ${attempt}`;
          await closeEverything(current);
          if(position.expect==='system'&&edge!=='bottom') {
            // Back from the system leaves the app unless something is open: hold the bottom menu open so the system's Back only closes it.
            const hold=stroke('bottom',positions(view,'bottom').find(item=>item.expect==='opens')!.distance,geometry);
            await device.swipe(hold.from,hold.to);
            await current.until(`${label}: the bottom menu to open`,`document.querySelector('.bottom-menu')?.getAttribute('data-open')==='true'`,5000);
            await delay(500);
          }
          await clearTouches(current);
          const {from,to}=stroke(edge,position.distance,geometry);
          await device.swipe(from,to);
          await delay(position.expect==='opens'?700:1200);
          const foreground=await device.foreground();
          if(position.expect==='system'&&edge==='bottom') {
            expect(foreground,`${label}: the launcher took the swipe`).not.toContain(appId);
            await device.shell(launch);await delay(2500);
            expect((await readView(current)).bottomMenu,`${label}: the bottom menu stays closed`).toBe(false);
          } else {
            const after=await readView(current);
            if(position.expect==='opens') {
              expect(opened(after,edge),`${label}: opens its page`).toBe(true);
              expect(foreground,`${label}: the app stays in front`).toContain(appId);
              await device.back();await delay(700);
              expect(opened(await readView(current),edge),`${label}: Back closes it first`).toBe(false);
              expect(await device.foreground(),`${label}: and the app stays in front`).toContain(appId);
            } else if(position.expect==='nothing') {
              expect(opened(after,'left')||opened(after,'right')||opened(after,'bottom'),`${label}: nothing opens`).toBe(false);
              expect(foreground,`${label}: the app stays in front`).toContain(appId);
              expect(after.touches.some(touch=>touch.startsWith('touchstart:')),`${label}: the page got the touch`).toBe(true);
            } else {
              expect(after.touches.some(touch=>touch.startsWith('touchcancel:')),`${label}: the system took the touch (the page saw a cancel)`).toBe(true);
              expect(after.sidebar||after.agentView,`${label}: the app's own gesture did not start`).toBe(false);
              expect(after.bottomMenu,`${label}: the system's Back closed the menu that was open`).toBe(false);
              expect(foreground,`${label}: the app stays in front`).toContain(appId);
            }
          }
          tally[`${edge} ${position.name}: ${position.expect}`]=attempt;
          await delay(300);
        }
      }
    }
    console.log(JSON.stringify({gesture:'swipe-matrix',overlay,zonesDp:view.insets,swipesPerPosition:tally}));
  },2_700_000);

  /** The three ways the activity is replaced or reconfigured under a running session; the manifest handles rotation itself, so it is a zone change, not a recreation. */
  type Recreation='restart'|'overlay'|'rotation';
  const recreations:Recreation[]=['restart','overlay','rotation'];
  async function recreate(kind:Recreation,overlay:Overlay) {
    if(kind==='restart') {
      // "Don't keep activities": leaving the app destroys the activity and coming back creates it again.
      await device.shell('settings put global always_finish_activities 1');
      try {await device.shell('input keyevent KEYCODE_HOME');await delay(1500);await device.shell(launch);await delay(1500);}
      finally {await device.shell('settings put global always_finish_activities 0');}
    } else if(kind==='overlay') {
      // The system recreates the activity of every app when the navigation overlay changes (what #1449 broke).
      const other=overlays.find(item=>item!==overlay&&available.includes(item))??overlay;
      await device.useNavigation(other);await delay(1500);await switchTo(overlay);await delay(1500);
    } else {
      await device.shell('settings put system accelerometer_rotation 0');
      try {await device.shell('settings put system user_rotation 1');await delay(1500);}
      finally {await device.shell('settings put system user_rotation 0');await delay(1500);}
    }
    page?.close();page=undefined;
    return session().catch(error=>{throw new Error(`after the ${kind} recreation: ${(error as Error).message}`);});
  }
  /** What was happening when a wait timed out: the page's touches and view, the keyboard and the window in front. */
  const waitFor=async(current:Page,what:string,expression:string)=>current.until(what,expression,4000).catch(async error=>{
    const view=await readView(current).catch(()=>null);
    const keyboard=/mInputShown=true/.test(await device.shell('dumpsys input_method').catch(()=>''));
    let again='';
    if(what.includes('Back to close')) {await device.back();await delay(1000);again=` secondBackClosed=${!(await current.evaluate<boolean>(`Boolean(${expression.slice(2,-1)})`).catch(()=>true))}`;}
    const shot=await device.screenshot();
    throw new Error(`${error.message}${again} screenshot=${shot}; view=${JSON.stringify(view)} keyboard=${keyboard} foreground=${await device.foreground().catch(()=>'')} calibration=${JSON.stringify(calibration)}`);
  });
  const pageOpen:Record<Edge,string>={
    left:"document.querySelector('.sidebar')?.classList.contains('sidebar-open')",
    bottom:"document.querySelector('.bottom-menu')?.getAttribute('data-open')==='true'",
    right:"[...document.querySelectorAll('[aria-label=\"Agent view\"]')].some(node=>node.getClientRects().length>0)",
  };

  /** #1435: Back must close what a swipe opened, every time, and a valid band swipe must always open it. */
  for(const overlay of overlays)test(`${overlay}: ${cycles} band swipes each followed by Back, with timing jitter and the activity recreated every tenth cycle`,async()=>{
    if(!available.includes(overlay))return;
    await switchTo(overlay);
    let current=await session(),view=await readView(current);
    const random=jitter(),edges:Edge[]=['left','bottom','right'],counts:Record<Recreation,number>={restart:0,overlay:0,rotation:0};
    for(let cycle=1;cycle<=cycles;cycle++) {
      if(cycle%10===0) {
        const kind=recreations[(cycle/10-1)%recreations.length];
        current=await recreate(kind,overlay);view=await readView(current);counts[kind]++;
      }
      const edge=edges[cycle%edges.length];
      const open=positions(view,edge).find(item=>item.expect==='opens'&&item.name!=='the screen edge')!;
      const label=`${overlay} cycle ${cycle} (${edge}, ${open.distance} dp)`;
      await clearTouches(current);
      const {from,to}=stroke(edge,open.distance,calibration!);
      const before=random(120),duration=150+random(100),beforeBack=random(120);
      await delay(before);
      await device.swipe(from,to,duration);
      await waitFor(current,`${label}: the page to open`,pageOpen[edge]);
      await delay(beforeBack);
      await device.back();
      await waitFor(current,`${label} (swipe ${duration} ms, Back ${beforeBack} ms after it opened): Back to close the page`,`!(${pageOpen[edge]})`);
      expect(await device.foreground(),`${label}: Back did not leave the app`).toContain(appId);
      await delay(900+random(100));
    }
    console.log(JSON.stringify({gesture:'band-swipes-with-back',overlay,cycles,recreations:counts}));
  },3_600_000);

  /** #1435 observation 2: one of thirty left-edge swipes at the claimed row did not open the menu. Misses are counted with what the page saw, not stopped at. */
  for(const overlay of overlays)test(`${overlay}: ${swipeRuns} left-band swipes at the claimed row open the side menu every time, with the page's touches recorded`,async()=>{
    if(!available.includes(overlay))return;
    await switchTo(overlay);
    const current=await session(),view=await readView(current),random=jitter(30);
    const bandPositions=positions(view,'left'),open=bandPositions.find(item=>item.name==='the middle of the band')??bandPositions.find(item=>item.name==='the start of the band')!;
    const {from,to}=stroke('left',open.distance,calibration!);
    const misses:{swipe:number;touches:string[];foreground:string;log:string[]}[]=[];
    let started=0,cancelled=0;
    for(let swipe=1;swipe<=swipeRuns;swipe++) {
      await clearTouches(current);
      await device.swipe(from,to,150+random(100));
      const deadline=Date.now()+2500;
      while(Date.now()<deadline&&!(await readView(current)).sidebar)await delay(100);
      const after=await readView(current);
      if(after.touches.some(touch=>touch.startsWith('touchstart:')))started++;
      if(after.touches.some(touch=>touch.startsWith('touchcancel:')))cancelled++;
      if(!after.sidebar)misses.push({swipe,touches:after.touches,foreground:await device.foreground(),log:(await device.shell('logcat -d -t 600 -v time').catch(()=>'')).split('\n').filter(line=>/EdgeGesture|app\.lazysh|InputDispatcher.*(cancel|Cancel)|GestureMonitor/.test(line)).slice(-25)});
      await closeEverything(current);
      await delay(400+random(200));
    }
    console.log(JSON.stringify({gesture:'left-band-swipes',overlay,swipes:swipeRuns,distanceDp:open.distance,touchstarts:started,touchcancels:cancelled,misses}));
    expect(misses,`${overlay}: left-band swipes that did not open the side menu`).toEqual([]);
  },3_600_000);
});
