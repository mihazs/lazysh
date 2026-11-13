import {expect,test,type Page} from '@playwright/test';
import {openSwipeWorkspace,touchscreen,type Touchscreen} from './fixtures/swipeHost';
import {reportGestureInsets} from './fixtures/gestureInsets';
import {bandOf,overlays,startDistances,type Overlay} from '../src/test/gestureOverlays';

/**
 * The regression matrix of #1380 (gestures against Android navigation) and #1435 (a band swipe must always open): on the real phone
 * layout, for each navigation overlay and zone width, a swipe that starts at 0 dp, inside the system zone, at both ends of the band, in
 * its middle and just beyond it, on each edge, opens the page only from the band. The band is derived from the documented geometry
 * (`bandOf`), not from the engine. Android's own Back and Home gestures are not here; tests/android-gestures.test.ts drives those.
 */
// A fresh phone: nothing stored, so the top bar is dropped for the side menu as on a real device.
test.use({viewport:{width:415,height:900},storageState:{cookies:[],origins:[]}});
const width=415,height=900,sideY=300;
const zoneKey='lazysh.preferences.v1';

const sidebar=(page:Page)=>page.locator('.sidebar');
const agentView=(page:Page)=>page.getByRole('region',{name:'Agent view',exact:true}).and(page.locator(':visible'));
const bottomMenu=(page:Page)=>page.getByRole('group',{name:'Bottom menu'});
/** The engine refuses a touch while the user types or a drag is settling; wait until it would accept one. */
const quiet=(page:Page)=>expect.poll(()=>page.evaluate(async()=>(await import('/src/edgeGestures.ts')).isTextInteractionActive())).toBe(false);
const isOpen={
  left:(page:Page)=>sidebar(page).evaluate(node=>node.classList.contains('sidebar-open')),
  right:(page:Page)=>agentView(page).count().then(count=>count>0),
  bottom:(page:Page)=>bottomMenu(page).isVisible(),
};
/** Back to the terminal with nothing open, by the controls a person has, so the next swipe starts from the same state. */
const closers={
  left:async(page:Page)=>{await page.keyboard.press('Escape');await expect(sidebar(page)).not.toHaveClass(/sidebar-open/);},
  // The phone has no top bar, so the Terminal | Agent switcher is not on screen: the opposite swipe returns.
  right:async(page:Page,touch:Touchscreen)=>{await quiet(page);await touch.swipe({x:width*0.4,y:sideY},{x:width-60,y:sideY});await expect(agentView(page)).toHaveCount(0);},
  bottom:async(page:Page)=>{await page.keyboard.press('Escape');await expect(bottomMenu(page)).toBeHidden();},
};
const swipeFrom=(edge:'left'|'right'|'bottom',distance:number)=>edge==='left'?{from:{x:distance,y:sideY},to:{x:distance+250,y:sideY}}
  :edge==='right'?{from:{x:width-distance,y:sideY},to:{x:width-distance-250,y:sideY}}
  :{from:{x:60,y:height-distance},to:{x:60,y:height-distance-300}};

async function openWorkspace(page:Page,overlay:Overlay,zoneWidth:number) {
  await page.addInitScript(([key,value])=>localStorage.setItem(key as string,JSON.stringify({version:1,...value as object})),[zoneKey,{edgeGestures:{zoneWidth}}]);
  await openSwipeWorkspace(page);
  const touch=await touchscreen(page,false);
  await reportGestureInsets(page,overlay.insets);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await page.waitForTimeout(400);
  return touch;
}
/** Whether a swipe from `distance` dp inside `edge` opened its page; an open page is closed again. */
async function opens(page:Page,touch:Touchscreen,edge:'left'|'right'|'bottom',distance:number) {
  await quiet(page);
  const {from,to}=swipeFrom(edge,distance);
  await touch.swipe(from,to);
  await page.waitForTimeout(400);
  const opened=await isOpen[edge](page);
  if(opened)await closers[edge](page,touch);
  return opened;
}

test.describe('phone',()=>{
  test.skip(({isMobile})=>!isMobile,'The swipes belong to phones.');
  // The default width on every overlay, and the preference's extremes on the two that differ most.
  const cases=overlays.flatMap(overlay=>[40,...(overlay.name==='threebutton'||overlay.name==='gestural_wide_back'?[16,96]:[])].map(zone=>[overlay,zone] as const));

  for(const [overlay,zone] of cases)test(`#1380 ${overlay.name}, zone ${zone} dp: each edge opens its page from the band and from nowhere else`,async({page})=>{
    const touch=await openWorkspace(page,overlay,zone);
    for(const edge of ['left','right','bottom'] as const){
      const band=bandOf(overlay.insets,edge,zone,'handles');
      for(const distance of startDistances(band)){
        const expected=distance>=band[0]&&distance<=band[1];
        expect(await opens(page,touch,edge,distance),`${edge} swipe from ${distance} dp (band ${band[0]} to ${band[1]})`).toBe(expected);
      }
    }
  });

  for(const overlay of overlays)test(`#1380 ${overlay.name}: the handles sit in the band, the navigation page and the bottom menu close by every control, and the handle returns`,async({page})=>{
    const touch=await openWorkspace(page,overlay,40);
    const left=page.locator('[data-gesture-handle="left"]'),bottom=page.locator('[data-gesture-handle="bottom"]');
    for(const handle of overlay.insets.navigation==='gesture'?[left,bottom]:[]){
      const grip=(await handle.boundingBox())!;
      // Beyond the Back zone at the side, above the Home zone at the bottom: never where the system takes the touch.
      if(handle===left)expect(grip.x).toBeGreaterThanOrEqual(overlay.insets.left);else expect(grip.y+grip.height).toBeLessThanOrEqual(height-overlay.insets.mandatoryBottom);
    }
    const [leftStart]=bandOf(overlay.insets,'left',40,'handles'),[bottomStart]=bandOf(overlay.insets,'bottom',40,'handles');
    // The navigation page: opens, hides its handle, and closes by Escape, the opposite swipe and its return button.
    for(const close of ['escape','swipe','button'] as const){
      await quiet(page);
      await touch.swipe({x:leftStart+10,y:sideY},{x:leftStart+260,y:sideY});
      await expect(sidebar(page)).toHaveClass(/sidebar-open/);
      await expect(left).toHaveCount(0);
      if(close==='escape')await page.keyboard.press('Escape');
      else if(close==='swipe'){await page.waitForTimeout(400);await quiet(page);await touch.swipe({x:width-60,y:sideY},{x:40,y:sideY});}
      else await page.getByRole('button',{name:'Return to terminal',exact:true}).first().tap();
      await expect(sidebar(page)).not.toHaveClass(/sidebar-open/);
      if(overlay.insets.navigation==='gesture')await expect(left).toBeVisible();
    }
    // The bottom menu: opens by its band, closes by Escape, the grip, the scrim and a swipe down.
    for(const close of ['escape','grip','scrim','swipe'] as const){
      await quiet(page);
      await touch.swipe({x:60,y:height-bottomStart-10},{x:60,y:height-bottomStart-310});
      await expect(bottomMenu(page)).toBeVisible();
      await page.waitForTimeout(400);
      if(close==='escape')await page.keyboard.press('Escape');
      else if(close==='grip')await bottomMenu(page).getByRole('button',{name:'Close bottom menu'}).click();
      else if(close==='scrim')await page.locator('.bottom-menu-scrim').click({position:{x:width/2,y:80}});
      else{await quiet(page);const panel=(await bottomMenu(page).boundingBox())!;await touch.swipe({x:width/2,y:panel.y+20},{x:width/2,y:panel.y+280});}
      await expect(bottomMenu(page),`closed by ${close}`).toBeHidden();
    }
    expect(await isOpen.left(page)||await isOpen.bottom(page)).toBe(false);
  });
});
