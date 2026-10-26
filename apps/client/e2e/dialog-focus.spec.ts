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
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();
});

test('Preferences trap excludes hidden, inert and disabled controls while following natural links and summaries',async({page})=>{
  await page.goto('/');const opener=page.getByRole('button',{name:'Preferences',exact:true});await opener.click();
  const dialog=page.getByRole('dialog',{name:'Preferences',exact:true});
  await expect(dialog.getByRole('spinbutton',{name:'Font size',exact:true})).toBeFocused();
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

test('credential dialog initially focuses its visible password and cancels without authentication',async({page})=>{
  await installNativeBridge(page);
  await page.addInitScript(()=>{
    const calls:string[]=[];(window as unknown as {dialogNativeCalls:string[]}).dialogNativeCalls=calls;
    window.nativeFixtureInvoke=async(command:string)=>{
      calls.push(command);
      if(command==='list_hosts')return [{id:'dialog-host',name:'Dialog fixture',hostname:'fixture.invalid',username:'fixture-user',port:22}];
      if(command==='local_capability'||command==='mosh_capability'||command==='et_capability')return {available:false,reason:'Synthetic dialog-only capability'};
      if(command==='has_credentials')return false;
      if(command==='cancel_credential_auth'||command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected dialog fixture command: ${command}`);
    };
  });
  await page.goto('/');const phone=(page.viewportSize()?.width??1280)<=600;
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const opener=page.getByRole('button',{name:'Connect to Dialog fixture',exact:true});await opener.click();
  const dialog=page.getByRole('dialog',{name:'Connect to Dialog fixture',exact:true});
  await expect(dialog.getByLabel('Password',{exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  if(!phone)await expect(opener).toBeFocused();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await opener.click();await expect(dialog.getByLabel('Password',{exact:true})).toBeFocused();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toHaveCount(0);
  if(!phone)await expect(opener).toBeFocused();
  expect(await page.evaluate(()=>(window as unknown as {dialogNativeCalls:string[]}).dialogNativeCalls)).not.toContain('connect');
});
