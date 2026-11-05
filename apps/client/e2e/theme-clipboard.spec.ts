import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {openThemeImport} from './fixtures/workspaceControl';
declare global{interface Window{themeClipboardFixture:{calls:string[];text:string}}}
const theme={v:1,name:'Clipboard dusk',mode:'light',colors:{background:'#f4efe6',foreground:'#1d1d1d'}};
/** Android bridge fixture: the WebView clipboard always fails, so only the native read can succeed. */
async function androidClipboard(page:Page,text:string){
  await installNativeBridge(page,{reason:'Synthetic Android clipboard fixture.',generation:'1'},{clipboardAndroid:true});
  await page.addInitScript(text=>{
    const calls:string[]=[];window.themeClipboardFixture={calls,text};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>{calls.push('webview');throw new Error('denied');},writeText:async()=>{}}});
    window.nativeFixtureInvoke=async command=>{
      calls.push(command);
      if(command==='clipboard_read')return {kind:'text',text:window.themeClipboardFixture.text};
      if(command==='list_hosts')return [];
      if(command==='app_icon_status')return {available:true,current:'default',reason:'Synthetic Android launcher fixture.'};
      if(command==='local_capability')return {available:false,reason:'Synthetic clipboard fixture; no shell runs.'};
      if(command.startsWith('plugin:'))return 1;
      return undefined;
    };
  },text);
}
const reads=(page:Page)=>page.evaluate(()=>window.themeClipboardFixture.calls.filter(call=>call==='clipboard_read'||call==='webview'));

test('Android clipboard theme import reads natively, previews and applies only after confirmation',async({page})=>{
  await androidClipboard(page,JSON.stringify(theme));
  await page.goto('/');await openThemeImport(page);
  await page.getByRole('button',{name:'Read theme from clipboard',exact:true}).click();
  const preview=page.getByRole('region',{name:'Theme preview'});
  await expect(preview.getByRole('heading',{name:'Clipboard dusk',exact:true})).toBeVisible();
  expect(await reads(page)).toEqual(['clipboard_read']);
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
  expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBeNull();
  await preview.getByRole('button',{name:'Apply to app and terminal',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','custom');
  await expect(page.locator('html')).toHaveCSS('--theme-bg',theme.colors.background);
  const size=await page.locator('.preferences-panel').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
});

for(const [label,text,error] of [
  ['invalid',JSON.stringify({...theme,colors:{background:'url(evil)',foreground:'#fff'}}),'Invalid theme color: background'],
  ['oversized',`{"name":"${'x'.repeat(20000)}"}`,'Theme input exceeds 16 KiB.'],
] as const)test(`Android clipboard theme import rejects ${label} input before any preview`,async({page})=>{
  await androidClipboard(page,text);
  await page.goto('/');await openThemeImport(page);
  const draft=page.getByLabel('Theme JSON or share code',{exact:true});
  await draft.fill('manual draft');
  await page.getByRole('button',{name:'Read theme from clipboard',exact:true}).click();
  await expect(page.getByText(error,{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Theme preview'})).toHaveCount(0);
  if(label==='oversized')await expect(draft).toHaveValue('manual draft');
  expect(await reads(page)).toEqual(['clipboard_read']);
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
});

test('browser clipboard theme import uses the clipboard API and still requires confirmation',async({page})=>{
  await page.addInitScript(text=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>text,writeText:async()=>{}}});},JSON.stringify(theme));
  await page.goto('/');await openThemeImport(page);
  await page.getByRole('button',{name:'Read theme from clipboard',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Clipboard dusk',exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
  await page.getByRole('button',{name:'Cancel preview',exact:true}).click();
  await expect(page.getByRole('region',{name:'Theme preview'})).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
});
