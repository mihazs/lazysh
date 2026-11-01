import {expect,test} from '@playwright/test';
import clientPackage from '../package.json' with {type:'json'};
import {installNativeBridge} from './fixtures/nativeBridge';

test('closed About notices wrap through visible summaries and restore their opener',async({page})=>{
  await page.goto('/');
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const opener=page.getByRole('button',{name:`About lazysh · ${clientPackage.version}`,exact:true});await opener.click();
  const dialog=page.getByRole('dialog',{name:'About lazysh',exact:true});
  const lastSummary=dialog.locator('summary').last();await expect(lastSummary).toBeVisible();
  const close=dialog.getByRole('button',{name:'Close About lazysh',exact:true});await close.focus();
  await page.keyboard.press('Shift+Tab');await expect(lastSummary).toBeFocused();
  await page.keyboard.press('Tab');await expect(close).toBeFocused();
  const mosh=dialog.locator('summary').filter({hasText:'Mosh notices'});
  await mosh.focus();await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'Mosh source and notices',exact:true})).toBeFocused();
  await page.keyboard.press('Shift+Tab');await expect(mosh).toBeFocused();await page.keyboard.press('Enter');
  await close.focus();await page.keyboard.press('Shift+Tab');await expect(lastSummary).toBeFocused();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  await expect((page.viewportSize()?.width??1280)<=600?page.getByRole('button',{name:'Open hosts',exact:true}):opener).toBeFocused();
});

test('Preferences trap excludes hidden, inert and disabled controls while following natural links and summaries',async({page})=>{
  await page.goto('/');const opener=page.getByRole('button',{name:'Preferences',exact:true});await opener.click();
  const dialog=page.getByRole('dialog',{name:'Preferences',exact:true});
  await expect(dialog.getByRole('button',{name:'Close Preferences',exact:true})).toBeFocused();
  await expect(dialog.getByRole('spinbutton',{name:'Font size',exact:true})).toBeHidden();
  expect(await dialog.locator('.dialog-content').evaluate(node=>node.scrollTop)).toBe(0);
  await dialog.evaluate(element=>{
    const fixture=document.createElement('div');fixture.id='dialog-focus-fixture';
    fixture.innerHTML='<details open><summary>Fixture section</summary><a href="#fixture-target">Fixture link</a></details><button disabled tabindex="0">Disabled button</button><fieldset disabled><button>Disabled fieldset child</button></fieldset><div hidden><button>Hidden child</button></div><div style="display:none"><button>No layout child</button></div><button style="visibility:hidden">Invisible button</button><div inert><button>Inert child</button></div><button tabindex="-1">Programmatic only</button><input type="hidden">';
    element.append(fixture);
  });
  const close=dialog.getByRole('button',{name:'Close Preferences',exact:true});
  const link=dialog.getByRole('link',{name:'Fixture link'}),summary=dialog.locator('#dialog-focus-fixture summary');
  await close.focus();await page.keyboard.press('Shift+Tab');await expect(link).toBeFocused();
  await page.keyboard.press('Tab');await expect(close).toBeFocused();
  await summary.focus();await page.keyboard.press('Enter');await close.focus();
  await page.keyboard.press('Shift+Tab');
  const collapsed=await dialog.locator('#dialog-focus-fixture').evaluate(element=>({active:document.activeElement?.textContent?.slice(0,80),controls:[...element.querySelectorAll<HTMLElement>('summary,a')].map(control=>({tag:control.tagName,rects:control.getClientRects().length,open:control.closest('details')?.open}))}));
  await expect(summary,JSON.stringify(collapsed)).toBeFocused();
  await page.keyboard.press('Tab');await expect(close).toBeFocused();
  await dialog.evaluate(element=>{const positive=document.createElement('button');positive.tabIndex=2;positive.textContent='Positive tab order';element.append(positive);});
  const positive=dialog.getByRole('button',{name:'Positive tab order'});await positive.focus();
  await page.keyboard.press('Shift+Tab');await expect(summary).toBeFocused();
  await page.keyboard.press('Tab');await expect(positive).toBeFocused();
  await dialog.evaluate(element=>{const helper=document.createElement('textarea');helper.setAttribute('aria-label','Offscreen helper');helper.style.cssText='position:absolute;left:-9999px;opacity:0';element.append(helper);});
  await positive.focus();await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('textbox',{name:'Offscreen helper'})).toBeFocused();
  await page.keyboard.press('Tab');await expect(positive).toBeFocused();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
});

for(const {saved,transport} of [{saved:false,transport:'mosh'},{saved:true,transport:'mosh'},{saved:true,transport:'auto'}] as const)test(`saved host ${transport} ${saved?'with':'without'} credentials prioritizes connecting and keeps options explicit`,async({page},testInfo)=>{
  await installNativeBridge(page);
  await page.addInitScript(({saved,transport})=>{
    const calls:string[]=[];(window as unknown as {dialogNativeCalls:string[]}).dialogNativeCalls=calls;
    window.nativeFixtureInvoke=async(command:string)=>{
      calls.push(command);
      if(command==='list_hosts')return [{id:'dialog-host',name:'Dialog fixture',hostname:'fixture.invalid',username:'fixture-user',port:22,transport,mosh:{serverPath:'/fixture/mosh-server',portMin:61000,portMax:61010}}];
      if(command==='local_capability'||command==='mosh_capability'||command==='et_capability')return {available:false,reason:'Synthetic dialog-only capability'};
      if(command==='transport_capabilities')return transport==='auto'?new Promise(resolve=>{(window as unknown as {dialogResolveTransport:()=>void}).dialogResolveTransport=()=>resolve({mosh:true,et:true});}):{mosh:true,et:true};
      if(command==='has_credentials')return saved;
      if(command==='cancel_credential_auth'||command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected dialog fixture command: ${command}`);
    };
  },{saved,transport});
  await page.goto('/');const phone=(page.viewportSize()?.width??1280)<=600;
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const opener=page.getByRole('button',{name:'Connect to Dialog fixture',exact:true});await opener.click();
  const dialog=page.getByRole('dialog',{name:'Connect to Dialog fixture',exact:true});
  const connect=dialog.getByRole('button',{name:'Connect',exact:true});
  const initial=saved?connect:dialog.getByLabel('Password',{exact:true});
  if(transport==='auto') {
    await expect(connect).toBeDisabled();
    await expect(dialog.locator('.destination')).toBeFocused();
    await page.evaluate(()=>(window as unknown as {dialogResolveTransport:()=>void}).dialogResolveTransport());
  }
  await expect(initial).toBeFocused();
  await expect(connect).toBeInViewport();
  await page.screenshot({path:testInfo.outputPath('saved-connection.png')});
  const options=dialog.locator('details').filter({hasText:'Connection options'});
  await expect(options).not.toHaveAttribute('open','');
  await expect(options.locator('summary')).toContainText('Mosh');
  const server=dialog.getByLabel('Mosh server path',{exact:true});
  await expect(server).not.toBeVisible();
  await options.locator('summary').click();await expect(server).toBeVisible();
  await expect(server).toHaveValue('/fixture/mosh-server');
  await expect(dialog.getByLabel('First UDP port',{exact:true})).toHaveValue('61000');
  await expect(dialog.getByLabel('Last UDP port',{exact:true})).toHaveValue('61010');
  if(saved) {
    await server.fill('');await options.locator('summary').click();await connect.click();
    await expect(options).toHaveAttribute('open','');await expect(server).toBeFocused();
    await server.fill('/fixture/mosh-server');
  }
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  if(!phone)await expect(opener).toBeFocused();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await opener.click();
  if(transport==='auto')await page.evaluate(()=>(window as unknown as {dialogResolveTransport:()=>void}).dialogResolveTransport());
  await expect(initial).toBeFocused();
  await expect(options).not.toHaveAttribute('open','');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toHaveCount(0);
  if(!phone)await expect(opener).toBeFocused();
  expect(await page.evaluate(()=>(window as unknown as {dialogNativeCalls:string[]}).dialogNativeCalls)).not.toContain('connect');
});
