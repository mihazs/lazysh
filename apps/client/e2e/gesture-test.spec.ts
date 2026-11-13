import {expect,test,type Page} from '@playwright/test';
import {openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';
import {oneUi,reportGestureInsets as report} from './fixtures/gestureInsets';
import {openGestureSettings} from './fixtures/gestureSettings';

async function openTestPage(page:Page) {
  await page.goto('/');
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByRole('button',{name:'Test gestures'}).click();
}
/** One finger down at `from`, moved to `to`, then lifted or cancelled: real touch input through one CDP session. */
async function finger(page:Page,from:{x:number;y:number},to:{x:number;y:number},end:'touchEnd'|'touchCancel') {
  const cdp=await page.context().newCDPSession(page);
  const send=(type:string,point?:{x:number;y:number})=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:point?[point]:[]});
  await send('touchStart',from);
  await send('touchMove',{x:(from.x+to.x)/2,y:(from.y+to.y)/2});
  await send('touchMove',to);
  await send(end);
  await cdp.detach();
}

test.describe('on a phone',()=>{
  test.skip(({isMobile})=>!isMobile,'Swipes need a touch screen.');
  test.use({viewport:{width:415,height:900}});

  test('draws the live system zones and says whether the system took each swipe',async({page},testInfo)=>{
    await openTestPage(page);
    await expect(page.locator('dd',{hasText:'Not detected, no system zones reported'})).toBeVisible();
    await report(page,oneUi);
    await expect(page.locator('dd',{hasText:'Android gesture navigation'})).toBeVisible();
    await expect(page.getByTestId('gesture-test-insets')).toHaveText('left 32 dp, right 32 dp, bottom 20 dp, Home 24 dp');
    await expect(page.getByRole('img').locator('i[data-kind="system"]')).toHaveCount(3);
    await expect(page.getByRole('img').locator('i[data-kind="handle"]')).toHaveCount(3);
    await page.screenshot({path:testInfo.outputPath('gesture-test-415x900.png')});

    await finger(page,{x:3,y:600},{x:90,y:600},'touchEnd');
    await expect(page.getByText('Swipe from the left edge reached the app',{exact:false})).toBeVisible();
    await finger(page,{x:200,y:892},{x:200,y:860},'touchCancel');
    await expect(page.getByText('Swipe from the bottom edge was taken by the system (Back, Home or Recents).')).toBeVisible();

    // A new report moves the drawn zones.
    await report(page,{...oneUi,left:56,right:56});
    await expect(page.getByTestId('gesture-test-insets')).toHaveText('left 56 dp, right 56 dp, bottom 20 dp, Home 24 dp');
  });
});

test('the gesture style is chosen in the same Settings page group and survives a reload',async({page})=>{
  await page.goto('/');
  await openGestureSettings(page);
  const style=page.getByRole('combobox',{name:'Gesture style'});
  await expect(style).toHaveValue('auto');
  await style.selectOption('edges');
  await page.reload();
  await openGestureSettings(page);
  await expect(page.getByRole('combobox',{name:'Gesture style'})).toHaveValue('edges');
});
