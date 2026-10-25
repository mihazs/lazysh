import {expect,test} from '@playwright/test';
for (const value of [
  {v:1,name:'Light 日光',mode:'light',colors:{background:'#ffffff',foreground:'#ffffff',cursor:'#eeeeee',red:'#ffffff'}},
  {v:1,name:'Dark 夜',mode:'dark',colors:{background:'#101010',foreground:'#101010',cursor:'#111111',red:'#101010'}},
]) test(`${value.mode} whole-app theme requires review, persists, exports, and reset removes custom styles`,async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await page.getByText('Import and share theme',{exact:true}).click();
  const input=page.getByLabel('Theme JSON or share code',{exact:true});
  await input.fill(JSON.stringify(value));
  await page.getByRole('button',{name:'Preview theme',exact:true}).click();
  await expect(page.getByRole('region',{name:'Theme preview'})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
  expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBeNull();
  await page.getByRole('button',{name:'Apply to app and terminal',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','custom');
  await expect(page.locator('html')).toHaveCSS('color-scheme',value.mode);
  await expect(page.getByRole('combobox',{name:'Terminal theme',exact:true})).toHaveValue('custom');
  await expect(page.locator('html')).toHaveCSS('--theme-bg',value.colors.background);
  // Actual controls inherit contrast-safe chrome, even though the supplied terminal foreground is white-on-white.
  const ratios=await page.getByRole('dialog').evaluate(dialog=>{
    const light=(color:string)=>color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    return Array.from(dialog.querySelectorAll('h2,p,label,input:not([type=checkbox]),select,button')).filter(e=>e.checkVisibility()&&getComputedStyle(e).opacity==='1').map(e=>{const fg=light(getComputedStyle(e).color);let parent:Element|null=e,bg='rgba(0, 0, 0, 0)';while(parent&&bg==='rgba(0, 0, 0, 0)'){bg=getComputedStyle(parent).backgroundColor;parent=parent.parentElement;}const b=light(bg);return {text:e.textContent?.slice(0,30),ratio:(Math.max(fg,b)+.05)/(Math.min(fg,b)+.05)};});
  });
  expect(ratios.filter(item=>item.ratio<4.5)).toEqual([]);
  await page.getByRole('button',{name:'Export theme share code',exact:true}).click();
  const code=await page.getByLabel('Exported theme',{exact:true}).inputValue();expect(code).toMatch(/^lazysh-theme:/);
  await page.reload();await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','custom');
  await page.getByText('Import and share theme',{exact:true}).click();
  await input.fill(code);await page.getByRole('button',{name:'Preview theme',exact:true}).click();
  await expect(page.getByRole('heading',{name:value.name,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel preview',exact:true}).click();
  await input.fill('{"v":1,"name":"Unsafe","mode":"light","colors":{"background":"url(evil)","foreground":"#fff"}}');
  await page.getByRole('button',{name:'Preview theme',exact:true}).click();
  await expect(page.getByRole('button',{name:'Apply to app and terminal',exact:true})).toHaveCount(0);
  await expect(page.locator('html')).toHaveCSS('--theme-bg',value.colors.background);
  await page.getByRole('button',{name:'Reset preferences',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
  expect(await page.locator('html').evaluate(e=>e.style.getPropertyValue('--theme-bg'))).toBe('');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
});
