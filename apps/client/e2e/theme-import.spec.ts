import {installThemeLocaleBridge} from './fixtures/themeLocaleBridge';
import {workspaceControl,openPreferenceCategory,openThemeImport} from './fixtures/workspaceControl';
import {controlContrast} from './fixtures/controlContrast';
import {expect,test} from '@playwright/test';
for (const value of [
  {v:1,name:'Light 日光',mode:'light',colors:{background:'#ffffff',foreground:'#ffffff',cursor:'#eeeeee',red:'#ffffff'}},
  {v:1,name:'Dark 夜',mode:'dark',colors:{background:'#101010',foreground:'#101010',cursor:'#111111',red:'#101010'}},
]) test(`${value.mode} whole-app theme requires review, persists, exports, and reset removes custom styles`,async({page})=>{
  await page.goto('/');
  await openThemeImport(page);
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
  const ratios=await page.getByRole('dialog').evaluate(controlContrast);
  expect(ratios.filter(item=>item.ratio<4.5)).toEqual([]);
  await page.getByRole('button',{name:'Export theme share code',exact:true}).click();
  const code=await page.getByLabel('Exported theme',{exact:true}).inputValue();expect(code).toMatch(/^lazysh-theme:/);
  await page.reload();await (await workspaceControl(page,'Preferences')).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','custom');
  await openPreferenceCategory(page,'Appearance');
  await page.getByText('Import and share theme',{exact:true}).click();
  await input.fill(code);await page.getByRole('button',{name:'Preview theme',exact:true}).click();
  await expect(page.getByRole('heading',{name:value.name,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel preview',exact:true}).click();
  await input.fill('{"v":1,"name":"Unsafe","mode":"light","colors":{"background":"url(evil)","foreground":"#fff"}}');
  await page.getByRole('button',{name:'Preview theme',exact:true}).click();
  await expect(page.getByRole('button',{name:'Apply to app and terminal',exact:true})).toHaveCount(0);
  await expect(page.locator('html')).toHaveCSS('--theme-bg',value.colors.background);
  await openPreferenceCategory(page,'Reset');
  await page.getByRole('button',{name:'Reset preferences',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
  expect(await page.locator('html').evaluate(e=>e.style.getPropertyValue('--theme-bg'))).toBe('');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
});

for(const palette of [null,'#767676','#757575','#ffffff','#000000'])test(`glass chrome keeps rendered normal-text contrast for ${palette??'lazysh'}`,async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';await page.setViewportSize(phone?{width:393,height:852}:{width:1200,height:800});await installThemeLocaleBridge(page);
  await page.addInitScript(()=>{const original=window.nativeFixtureInvoke;window.nativeFixtureInvoke=async(command,args,options)=>{
    if(command==='local_capability')return {available:true,reason:'Owned theme fixture; no shell starts.'};
    if(command==='local_connect')return {sessionId:'local:theme-contrast'};
    if(['local_resize','local_ack','local_disconnect'].includes(command))return;
    return original(command,args,options);
  };});
  await page.goto('/');await openThemeImport(page);
  if(palette){await page.getByLabel('Theme JSON or share code',{exact:true}).fill(JSON.stringify({v:1,name:'Owned contrast',mode:palette==='#000000'?'dark':'light',colors:{background:palette,foreground:'#000000',cursor:'#000000'}}));await page.getByRole('button',{name:'Preview theme',exact:true}).click();await page.getByRole('button',{name:'Apply to app and terminal',exact:true}).click();}
  for(const terminal of ['midnight','paper']){
    await page.getByRole('combobox',{name:'Terminal theme',exact:true}).selectOption(terminal);await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
    if(terminal==='midnight'){if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();await page.getByRole('button',{name:'Open local terminal',exact:true}).click();}
    await expect(page.locator('.xterm-screen')).toBeVisible();await expect(page.getByText('Opening terminal…',{exact:true})).toHaveCount(0);
    if(phone)await page.getByRole('button',{name:'Workspace tools',exact:true}).click();const dialog=phone?page.getByRole('dialog',{name:'Workspace tools',exact:true}):page.locator('.workspace-header');const heading=phone?dialog.getByRole('heading',{name:'Workspace tools',exact:true}):dialog.locator('.session-switcher-trigger');const media=await page.context().newCDPSession(page);
    for(const reduced of [false,true]){
      await media.send('Emulation.setEmulatedMedia',{features:reduced?[{name:'prefers-reduced-transparency',value:'reduce'}]:[]});await page.mouse.move(0,0);await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
      const sample=await heading.evaluate((e,phone)=>{const b=(phone?e:e.closest('.workspace-header')!).getBoundingClientRect(),x=phone?b.right+12:b.x+b.width/2,y=b.y+b.height/2,node=document.elementFromPoint(x,y);return {x,y,color:getComputedStyle(e).color,owned:phone?node===e.parentElement:node===e.closest('.workspace-header')||node===e.parentElement};},phone);expect(sample.owned).toBe(true);
      const png=await page.screenshot({path:testInfo.outputPath(`${terminal}-${reduced?'solid':'glass'}.png`)});
      const measured=await page.evaluate(async({png,sample})=>{
        const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d')!;context.drawImage(bitmap,0,0);bitmap.close();
        const rgb=Array.from(context.getImageData(Math.floor(sample.x),Math.floor(sample.y),1,1).data).slice(0,3),foreground=sample.color.match(/[\d.]+/g)!.slice(0,3).map(Number);const hex=(v:number[])=>'#'+v.map(c=>c.toString(16).padStart(2,'0')).join('');const {contrast}=await import('/src/themeImport.ts');return {rgb,foreground,ratio:contrast(hex(rgb),hex(foreground))};
      },{png:png.toString('base64'),sample});
      await testInfo.attach(`${terminal}-${reduced}-contrast`,{body:JSON.stringify({sample,measured}),contentType:'application/json'});expect(measured.ratio).toBeGreaterThanOrEqual(4.5);if(palette==='#767676')expect(measured.foreground).toEqual([0,0,0]);
      const surface=await dialog.evaluate(e=>({background:getComputedStyle(e).backgroundColor,filter:getComputedStyle(e).backdropFilter,floor:getComputedStyle(e).getPropertyValue('--theme-glass-opacity-floor')}));console.log('Glass contrast receipt',JSON.stringify({viewport:page.viewportSize(),surface:phone?'Workspace tools sheet':'Workspace header/session switcher',palette,terminal,reduced,sample,measured,css:surface}));if(reduced){expect(surface.filter).toBe('none');expect(surface.background).not.toContain('/');}else {expect(surface.filter).toContain('blur');expect(surface.background).toContain('/');if(!palette)expect(surface.background).toContain(phone?'/ 0.83':'/ 0.84');}
    }
    await page.emulateMedia({forcedColors:'active'});expect(await dialog.evaluate(e=>getComputedStyle(e).backdropFilter)).toBe('none');expect(await dialog.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toContain('/');await page.emulateMedia({forcedColors:'none'});
    await media.send('Emulation.setEmulatedMedia',{features:[]});if(phone)await dialog.getByRole('button',{name:'Close Workspace tools',exact:true}).click();
    if(terminal==='midnight'){if(phone){await page.getByRole('button',{name:'Workspace tools',exact:true}).click();}await (await workspaceControl(page,'Preferences')).click();await openPreferenceCategory(page,'Appearance');}
  }
});
