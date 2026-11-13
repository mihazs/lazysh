import {expect,test,type Page,type TestInfo} from '@playwright/test';
import {connectAttachmentTerminal,openAttachmentTerminal} from './fixtures/attachmentTerminal';
import {oneUi,reportGestureInsets} from './fixtures/gestureInsets';
import {installLocalTerminal} from './fixtures/localTerminal';
import {swipe} from './fixtures/touchSwipe';
import {closePreferences,workspaceControl} from './fixtures/workspaceControl';

// The phone project seeds every spec with the tour already seen; these start as a new device.
test.use({storageState:{cookies:[],origins:[]}});
const key='lazysh.gestureTour.v1';
const phone=(testInfo:TestInfo)=>testInfo.project.name==='phone';
const tour=(page:Page)=>page.getByRole('dialog',{name:'Gesture tour',exact:true});
const stored=(page:Page)=>page.evaluate(key=>localStorage.getItem(key),key);
/** Seeds storage once per tab session, so a reload keeps what the page itself wrote afterwards. */
const seed=(page:Page,entries:Record<string,string>)=>page.addInitScript(entries=>{
  if(sessionStorage.getItem('seeded'))return;
  sessionStorage.setItem('seeded','1');
  for(const [name,value] of Object.entries(entries))localStorage.setItem(name,value);
},entries);
/** A connected SSH session; the connection list (the drawer on a phone) comes first. */
const connect=(page:Page)=>connectAttachmentTerminal(page,{nonce:'e'.repeat(64),ready:'gesture-tour-ready'});
/** Connects the device's first phone session and waits for the tour that opens over it. */
async function connectToTour(page:Page) {
  const dialog=await connectToTour(page);
  return dialog;
}
const finger=(page:Page)=>tour(page).locator('.gt-finger');
const animation=(page:Page)=>finger(page).evaluate(node=>getComputedStyle(node).animationName);
const titles=['Swipe in from the left edge','Swipe up from the bottom edge','Swipe in from the right edge','No swipes while you type'];

test('does not open on the connection list',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await installLocalTerminal(page);
  await page.goto('/');
  await page.waitForTimeout(1800);
  await expect(tour(page)).toHaveCount(0);
  expect(await stored(page)).toBeNull();
});

test('opens once over the first connected phone session and Done keeps it away after a reload',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  const dialog=await connectToTour(page);
  await expect(dialog.getByRole('button',{name:'Next',exact:true})).toBeFocused();
  const steps=[
    [titles[0],'open the side menu','Step 1 of 4'],
    [titles[1],'where the small bar sits','Step 2 of 4'],
    [titles[2],'Agent view','Step 3 of 4'],
    [titles[3],'stay off while you type','Step 4 of 4'],
  ];
  for(const [index,[title,body,progress]] of steps.entries()){
    await expect(dialog.getByRole('heading',{name:title,exact:true})).toBeVisible();
    await expect(dialog.locator('.gt-copy')).toContainText(body);
    await expect(dialog).toContainText(progress);
    await page.screenshot({path:testInfo.outputPath(`step-${index+1}.png`)});
    if(index<steps.length-1)await dialog.getByRole('button',{name:'Next',exact:true}).tap();
  }
  await expect(dialog.getByRole('button',{name:'Skip',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Done',exact:true}).tap();
  await expect(dialog).toHaveCount(0);
  expect(await stored(page)).toBe('1');
  await page.reload();
  await openAttachmentTerminal(page);
  await page.waitForTimeout(1800);
  await expect(tour(page)).toHaveCount(0);
});

test('never opens on desktop, where there are no edge gestures',async({page},testInfo)=>{
  test.skip(phone(testInfo),'desktop only');
  await connect(page);
  await page.waitForTimeout(1800);
  await expect(tour(page)).toHaveCount(0);
  expect(await stored(page)).toBeNull();
});

test('Skip ends it for good, and the keyboard reaches every control',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  const dialog=await connectToTour(page);
  const next=dialog.getByRole('button',{name:'Next',exact:true}),skip=dialog.getByRole('button',{name:'Skip',exact:true}),close=dialog.getByRole('button',{name:'Close Gesture tour',exact:true});
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading',{name:titles[1]})).toBeVisible();
  // The dialog is a focus trap: Tab runs Close, Skip, Next and wraps.
  await close.focus();
  await page.keyboard.press('Tab');await expect(skip).toBeFocused();
  await page.keyboard.press('Tab');await expect(next).toBeFocused();
  await page.keyboard.press('Tab');await expect(close).toBeFocused();
  await skip.focus();
  await page.keyboard.press('Space');
  await expect(dialog).toHaveCount(0);
  expect(await stored(page)).toBe('1');
});

test('Escape closes it and records that it was seen',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await connect(page);
  await expect(tour(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  expect(await stored(page)).toBe('1');
});

test('a device that saw an older tour sees the new one once',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await seed(page,{[key]:'0'});
  await connect(page);
  await expect(tour(page)).toBeVisible();
  await tour(page).getByRole('button',{name:'Skip',exact:true}).tap();
  expect(await stored(page)).toBe('1');
});

test('a switched-off gesture and the kept top bar say where to turn them on',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await seed(page,{'lazysh.show-top-bar.v1':'true','lazysh.preferences.v1':JSON.stringify({version:1,edgeGestures:{bottomMenu:false}})});
  await connect(page);
  const dialog=tour(page),notes=dialog.locator('.gt-off');
  await expect(dialog).toBeVisible();
  await expect(notes).toContainText('The top bar is on for this device');
  await dialog.getByRole('button',{name:'Next',exact:true}).tap();
  await expect(notes).toContainText('Turn it on in Preferences, under Keyboard and gestures, then Terminal touch gestures.');
  await dialog.getByRole('button',{name:'Next',exact:true}).tap();
  await expect(notes).toHaveCount(0);
});

test('on Android gesture navigation the tour draws the handle and says to start from it; Edge swipes keep the rows rule',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  const dialog=await connectToTour(page);
  await expect(dialog.locator('.gt-handle')).toHaveCount(0);
  await reportGestureInsets(page,oneUi);
  await expect(dialog.locator('.gt-handle')).toHaveCount(1);
  await expect(dialog.locator('.gt-zone')).toHaveCount(0);
  await expect(dialog.locator('.gt-copy')).toContainText('start each swipe from its small handle');
  await page.screenshot({path:testInfo.outputPath('handles.png')});
  await dialog.getByRole('button',{name:'Next',exact:true}).tap();
  await expect(dialog.locator('.gt-handle')).toHaveCount(1);
  await dialog.getByRole('button',{name:'Skip',exact:true}).tap();
});

test('with the Edge swipes style on gesture navigation the tour keeps the rows rule and draws the zone',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await seed(page,{'lazysh.preferences.v1':JSON.stringify({version:1,edgeGestures:{mode:'edges'}})});
  await connect(page);
  await expect(tour(page)).toBeVisible();
  await reportGestureInsets(page,oneUi);
  await expect(tour(page).locator('.gt-copy')).toContainText('start the side swipes low on the edge');
  await expect(tour(page).locator('.gt-zone')).toHaveCount(1);
  await expect(tour(page).locator('.gt-handle')).toHaveCount(0);
});

test('with every gesture switched off it does not open by itself',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await seed(page,{'lazysh.preferences.v1':JSON.stringify({version:1,edgeGestures:{leftMenu:false,bottomMenu:false,viewSwitch:false}})});
  await connect(page);
  await page.waitForTimeout(1800);
  await expect(tour(page)).toHaveCount(0);
  expect(await stored(page)).toBeNull();
});

test('screen-reader mode never opens it over the terminal; Help has the same text and plays the tour on request',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await seed(page,{'lazysh.preferences.v1':JSON.stringify({version:1,screenReader:true})});
  await connect(page);
  await page.waitForTimeout(1800);
  await expect(tour(page)).toHaveCount(0);
  await (await workspaceControl(page,'Preferences')).click();
  const preferences=page.getByRole('dialog',{name:'Preferences',exact:true});
  await preferences.getByRole('button',{name:'Gestures',exact:true}).click();
  const text=preferences.locator('.gt-help');
  for(const title of titles)await expect(text.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await expect(text.getByText('Screen-reader mode is on')).toHaveCount(3);
  await expect(text.locator('svg')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('help-page.png')});
  await text.getByRole('button',{name:'Play the animated tour',exact:true}).click();
  await expect(preferences).toHaveCount(0);
  await expect(tour(page)).toBeVisible();
  await expect(tour(page).getByRole('heading',{name:titles[0]})).toBeVisible();
  await tour(page).getByRole('button',{name:'Skip',exact:true}).click();
  await expect(tour(page)).toHaveCount(0);
});

test('the side menu replays the tour after it was seen, and Preferences closes without opening it',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await seed(page,{[key]:'1'});
  await connect(page);
  // The side menu is the one full-screen page; the application rows are on its Connections tab.
  const menu=page.getByRole('complementary',{name:'Hosts and connections',exact:true});
  const openMenu=async()=>{await page.waitForTimeout(900);await swipe(page,[2,520],[300,524]);await expect(page.locator('.sidebar')).toHaveClass(/sidebar-open/);await menu.getByRole('navigation',{name:'Workspace navigation',exact:true}).getByRole('button',{name:'Connections'}).tap();};
  await openMenu();
  await menu.getByRole('button',{name:'Preferences',exact:true}).tap();
  await closePreferences(page);
  await page.waitForTimeout(1800);
  await expect(tour(page)).toHaveCount(0);
  await openMenu();
  await menu.getByRole('button',{name:'Gesture tour',exact:true}).tap();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await expect(tour(page)).toBeVisible();
  await expect(tour(page).getByRole('heading',{name:titles[0]})).toBeVisible();
});

test('teaches what the app does: the left and bottom swipes open their menus, and typing switches them off',async({page},testInfo)=>{
  test.skip(!phone(testInfo),'phones only');
  await seed(page,{[key]:'1'});
  await connect(page);
  const drawer=page.locator('.sidebar'),bottom=page.getByRole('group',{name:'Bottom menu'});
  // Typing: a key just pressed holds the swipes off for a moment (the typing step's rule) ...
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type('x');
  await swipe(page,[2,520],[300,524]);
  await page.waitForTimeout(300);
  await expect(drawer).not.toHaveClass(/sidebar-open/);
  // ... and once the typing has stopped, the left edge opens the side menu and the bottom edge the bottom menu.
  await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
  await page.waitForTimeout(900);
  await swipe(page,[2,520],[300,524]);
  await expect(drawer).toHaveClass(/sidebar-open/);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toHaveClass(/sidebar-open/);
  await page.waitForTimeout(900);
  const height=await page.evaluate(()=>window.innerHeight);
  await swipe(page,[207,height-8],[207,height-300]);
  await expect(bottom).toBeVisible();
});

test.describe('motion',()=>{
  test('animates the finger by default',async({page},testInfo)=>{
    test.skip(!phone(testInfo),'phones only');
    await connect(page);
    await expect(tour(page)).toBeVisible();
    for(const title of titles.slice(0,3)){
      await expect(tour(page).getByRole('heading',{name:title})).toBeVisible();
      expect(await animation(page)).toMatch(/^gt-swipe/);
      await tour(page).getByRole('button',{name:'Next',exact:true}).tap();
    }
  });
  test.describe('reduced motion',()=>{
    test.use({reducedMotion:'reduce'});
    test('shows static illustrations with the same captions',async({page},testInfo)=>{
      test.skip(!phone(testInfo),'phones only');
      await connect(page);
      await expect(tour(page)).toBeVisible();
      for(const title of titles){
        await expect(tour(page).getByRole('heading',{name:title})).toBeVisible();
        expect(await animation(page)).toBe('none');
        expect(await tour(page).locator('.gt-panel').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName))).not.toContain('gt-reveal');
        await page.screenshot({path:testInfo.outputPath(`static-${title.replace(/\W+/g,'-').toLowerCase()}.png`)});
        if(title!==titles[3])await tour(page).getByRole('button',{name:'Next',exact:true}).tap();
      }
      await tour(page).getByRole('button',{name:'Done',exact:true}).tap();
      await expect(tour(page)).toHaveCount(0);
    });
  });
});
