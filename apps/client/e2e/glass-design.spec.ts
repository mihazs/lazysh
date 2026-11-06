import {expect,test,type Locator,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {controlContrast} from './fixtures/controlContrast';
import {designAudit} from './fixtures/designAudit';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';

type AppTheme='forest'|'midnight'|'paper';
const host={id:'design-host',name:'Build box',host:'build.example',port:22,username:'dev',transport:'ssh'};

/** The real app over an owned local shell that writes nothing, in the chosen bundled app theme. */
async function openApp(page:Page,appTheme:AppTheme) {
  await installNativeBridge(page,undefined,{nativeEvents:true});
  await page.addInitScript(({appTheme,host})=>{
    let terminals=0;
    if(!sessionStorage.getItem('design-seeded')){sessionStorage.setItem('design-seeded','1');localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,appTheme}));}
    const replies:Record<string,unknown>={list_hosts:[host],app_icon_status:{available:false,current:'unknown',reason:'Design fixture.'},
      local_capability:{available:true,reason:'Design fixture; no shell runs.'},theme_link_status:false,
      local_write:undefined,local_resize:undefined,local_ack:undefined,local_disconnect:undefined};
    window.nativeFixtureInvoke=async command=>{
      if(command==='local_connect')return {sessionId:`local:design-${++terminals}`};
      if(command in replies)return replies[command];
      throw new Error(`Unexpected design fixture command: ${command}`);
    };
  },{appTheme,host});
  await page.goto('/');
}
async function openLocalTerminal(page:Page,phone:boolean) {
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.locator('.xterm-screen:visible').first()).toBeVisible();
}
/** WCAG contrast between two opaque sRGB colours given as 0-255 channels. */
function contrast(a:number[],b:number[]) {
  const lum=(channels:number[])=>channels.slice(0,3).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const [x,y]=[lum(a),lum(b)];
  return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
const audit=(page:Page)=>page.evaluate(designAudit);
const expectSubtle=async(page:Page,where:string)=>expect(await audit(page),where).toEqual({borderedControls:[],cyan:[]});
/** Text on a translucent surface keeps AA over the worst underlay it can float above. */
async function expectReadableGlass(surface:Locator,where:string) {
  await surface.page().evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
  const samples=await surface.evaluate(controlContrast,{isolate:true});
  expect(samples.length,where).toBeGreaterThan(0);
  expect(samples.filter(sample=>sample.ratio<4.5),where).toEqual([]);
}
const material=(surface:Locator)=>surface.evaluate(node=>{const style=getComputedStyle(node);return {background:style.backgroundColor,filter:style.backdropFilter};});
async function expectGlass(surface:Locator,where:string) {
  const {background,filter}=await material(surface);
  expect(filter,where).toContain('blur(');
  expect(background,where).toMatch(/\/ 0\.\d+\)$|rgba\(.*, 0\.\d+\)$/);
}
async function expectSolid(surface:Locator,where:string) {
  const {background,filter}=await material(surface);
  expect(filter,where).toBe('none');
  expect(background,where).not.toMatch(/\/ 0\.\d+\)$|rgba\(.*, 0\.\d+\)$/);
}

for(const appTheme of ['forest','midnight','paper'] as const)test(`${appTheme} controls stay borderless with a visible focus ring and no cyan accents`,async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await openApp(page,appTheme);
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await expectSubtle(page,'connections');
  // Keyboard focus reaches a control and draws a solid ring that stands out from its surface.
  const add=page.getByRole('button',{name:'Add a host',exact:true});
  // A key press sets keyboard modality, so the focused control matches :focus-visible.
  await page.keyboard.press('Shift');await add.focus();
  await expect(add).toBeFocused();
  const ring=await add.evaluate(node=>{
    const style=getComputedStyle(node);
    const context=document.createElement('canvas').getContext('2d')!;
    const rgb=(color:string)=>{context.fillStyle=color;context.fillRect(0,0,1,1);return Array.from(context.getImageData(0,0,1,1).data);};
    let surface=node.parentElement!;while(getComputedStyle(surface).backgroundColor==='rgba(0, 0, 0, 0)'&&surface.parentElement)surface=surface.parentElement;
    return {visible:node.matches(':focus-visible'),style:style.outlineStyle,width:parseFloat(style.outlineWidth),outline:rgb(style.outlineColor),surface:rgb(getComputedStyle(surface).backgroundColor)};
  });
  expect(ring.visible).toBe(true);expect(ring.style).toBe('solid');expect(ring.width).toBeGreaterThanOrEqual(2);expect(contrast(ring.outline,ring.surface)).toBeGreaterThanOrEqual(3);
  await add.click();
  const editor=page.getByRole('dialog',{name:'Add a host',exact:true});
  await editor.locator('details:not([open]) > summary').evaluateAll(nodes=>nodes.forEach(node=>(node as HTMLElement).click()));
  await expectSubtle(page,'host editor');
  await page.screenshot({path:testInfo.outputPath(`${appTheme}-host-editor.png`)});
  await editor.getByRole('button',{name:'Close Add a host',exact:true}).click();
  if(phone && !await page.getByRole('button',{name:'Open local terminal',exact:true}).isVisible())await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expectSubtle(page,'terminal');
  // The terminal keeps the user's own terminal theme; only the app chrome changed.
  expect(await page.locator('.xterm-viewport').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(16, 19, 17)');
  await page.screenshot({path:testInfo.outputPath(`${appTheme}-terminal.png`)});
  if(phone){
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await expectSubtle(page,'workspace tools');
    await page.getByRole('dialog',{name:'Workspace tools',exact:true}).getByRole('button',{name:'Close Workspace tools',exact:true}).click();
  }
  await (await workspaceControl(page,'Preferences')).click();
  for(const category of ['Connections','Language','Appearance','Terminal','Input','Reset','Security','Notifications'] as const){
    await openPreferenceCategory(page,category);
    await page.locator('.settings-navigation [data-settings-page]:visible details:not([open]) > summary').evaluateAll(nodes=>nodes.forEach(node=>(node as HTMLElement).click()));
    await expectSubtle(page,`preferences ${category}`);
  }
  await page.screenshot({path:testInfo.outputPath(`${appTheme}-preferences.png`)});
});

for(const appTheme of ['forest','midnight','paper'] as const)test(`${appTheme} glass chrome keeps AA text and turns solid for reduced transparency and more contrast`,async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await openApp(page,appTheme);
  await openLocalTerminal(page,phone);
  const toolbar=page.getByLabel('Terminal keys',{exact:true});
  const header=page.locator('.workspace-header');
  const media=await page.context().newCDPSession(page);
  const surfaces=async()=>{
    if(!phone){await (await workspaceControl(page,'Preferences')).click();await openPreferenceCategory(page,'Appearance');return [toolbar,header,page.getByRole('dialog',{name:'Preferences',exact:true})];}
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    return [toolbar,header,page.getByRole('dialog',{name:'Workspace tools',exact:true})];
  };
  const close=async()=>phone?page.getByRole('button',{name:'Close Workspace tools',exact:true}).click():closePreferences(page);
  for(const surface of await surfaces()){await expectGlass(surface,`glass ${await surface.getAttribute('class')}`);await expectReadableGlass(surface,`text on ${await surface.getAttribute('class')}`);}
  await page.screenshot({path:testInfo.outputPath(`${appTheme}-glass.png`)});
  await close();
  for(const features of [[{name:'prefers-reduced-transparency',value:'reduce'}],[{name:'prefers-contrast',value:'more'}]]){
    await media.send('Emulation.setEmulatedMedia',{features});
    for(const surface of await surfaces())await expectSolid(surface,`${features[0].name} ${await surface.getAttribute('class')}`);
    if(features[0].name==='prefers-contrast'){
      // More contrast brings control edges back instead of relying on subtle fills.
      expect((await audit(page)).borderedControls.length).toBeGreaterThan(0);
      await page.screenshot({path:testInfo.outputPath(`${appTheme}-more-contrast.png`)});
    }
    await close();
  }
  await media.send('Emulation.setEmulatedMedia',{features:[]});
  await expectSubtle(page,'restored');
});

/** The current item's own cue: an opaque fill plus an inset bar that must reach 3:1 against both fills. */
function currentCue(current:Locator) {
  return current.evaluate(node=>{
    const context=document.createElement('canvas').getContext('2d')!;
    const rgb=(color:string)=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return Array.from(context.getImageData(0,0,1,1).data);};
    const other=Array.from(node.parentElement!.children).find(sibling=>sibling!==node&&sibling.tagName==='BUTTON')!;
    const style=getComputedStyle(node),bar=style.boxShadow.match(/^(.+\))\s+([\d.]+)px 0px 0px 0px inset$/);
    return {bar:bar?rgb(bar[1]):[],width:bar?Number(bar[2]):0,current:rgb(style.backgroundColor),other:rgb(getComputedStyle(other).backgroundColor),otherShadow:getComputedStyle(other).boxShadow};
  });
}
async function expectCurrentCue(current:Locator,where:string) {
  await current.page().mouse.move(0,0);
  const cue=await currentCue(current);
  expect({width:cue.width>=2,opaque:cue.current[3]===255&&cue.other[3]===255,otherShadow:cue.otherShadow},where).toEqual({width:true,opaque:true,otherShadow:'none'});
  expect(contrast(cue.bar,cue.current),`${where} bar on the current fill`).toBeGreaterThanOrEqual(3);
  expect(contrast(cue.bar,cue.other),`${where} bar beside the other fill`).toBeGreaterThanOrEqual(3);
}

for(const appTheme of ['forest','midnight','paper'] as const)test(`${appTheme} current session keeps a 3:1 cue without an outline`,async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await openApp(page,appTheme);
  await openLocalTerminal(page,phone);
  await openLocalTerminal(page,phone);
  await expect(page.locator('.session-tabs [role="tab"]')).toHaveCount(2);
  await page.getByRole('button',{name:'Switch terminal session',exact:true}).click();
  const switcher=page.getByRole('dialog',{name:'Switch terminal session',exact:true});
  await expect(switcher.locator('.session-choice')).toHaveCount(2);
  await expectCurrentCue(switcher.locator('.session-choice[aria-current="true"]'),'session switcher');
  await page.keyboard.press('Escape');
  await expect(switcher).toHaveCount(0);
  if(phone)return;
  await page.locator('[data-workspace-mode="workspaces"]').click();
  const summary=page.locator('.workspace-session-summary');
  if(await summary.isVisible())await summary.click();
  const live=page.getByRole('group',{name:'Live app sessions',exact:true});
  await expect(live.getByRole('button')).toHaveCount(2);
  await expectCurrentCue(live.locator('button[aria-current="location"]'),'live sessions');
});
