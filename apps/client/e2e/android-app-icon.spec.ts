import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl,openPreferenceCategory} from './fixtures/workspaceControl';
declare global{interface Window{androidIconFixture:{current:string;calls:unknown[]}}}
const reason='The launcher icon is managed by Android on this device. Your open sessions stay connected; the launcher may take a moment to show the new icon.';
test('Android launcher icon picker applies only native readback and never shows iOS-only guidance',async({page})=>{
  await installNativeBridge(page,{reason:'Synthetic Android icon fixture.',generation:'1'},{clipboardAndroid:true});
  await page.addInitScript(reason=>{
    const fixture={current:'default',calls:[] as unknown[]};window.androidIconFixture=fixture;
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='app_icon_status')return {available:true,current:fixture.current,reason};
      if(command==='set_app_icon'){fixture.calls.push(args);fixture.current=String(args.icon);return {available:true,current:fixture.current,reason};}
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Synthetic icon fixture; no shell runs.'};
      if(command.startsWith('plugin:'))return 1;
      return undefined;
    };
  },reason);
  await page.goto('/');await (await workspaceControl(page,'Preferences')).click();await openPreferenceCategory(page,'Appearance');
  const group=page.getByRole('group',{name:'App icon',exact:true});
  await expect(group.getByText(reason,{exact:true})).toBeVisible();
  await expect(group.getByText('Current icon: Default',{exact:true})).toBeVisible();
  await expect(group).not.toContainText('iOS');
  const apply=group.getByRole('button',{name:'Apply app icon',exact:true});
  await expect(apply).toBeDisabled();
  await group.getByRole('combobox',{name:'Home Screen icon',exact:true}).selectOption('amber');
  await apply.click();
  await expect(group.getByText('Current icon: Amber',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.androidIconFixture.calls)).toEqual([{icon:'amber'}]);
  await expect(apply).toBeDisabled();
  const size=await page.locator('.preferences-panel').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
});
