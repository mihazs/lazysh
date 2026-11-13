import {expect,test,type Locator,type Page} from '@playwright/test';
import {connectAttachmentTerminal} from './fixtures/attachmentTerminal';
import {startLocalTerminal} from './fixtures/localTerminal';
import {swipe} from './fixtures/touchSwipe';
import {openPreferenceCategory} from './fixtures/workspaceControl';

const topBarKey='lazysh.show-top-bar.v1';
/** The side menu is the full-screen navigation page: the one `aside` of hosts, Workspaces and Agents. */
const menu=(page:Page)=>page.getByRole('complementary',{name:'Hosts and connections',exact:true});
const header=(page:Page)=>page.locator('.workspace-header');
const open=(page:Page)=>expect(page.locator('.sidebar')).toHaveClass(/sidebar-open/);
const shut=(page:Page)=>expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
/** The page has finished sliding: it rests at the left edge. */
const settled=async(page:Page)=>expect.poll(()=>page.locator('.sidebar').evaluate(node=>Math.round(node.getBoundingClientRect().left))).toBe(0);
// The engine holds edge swipes for a moment after a key press, so a swipe never follows typing.
const openBySwipe=async(page:Page)=>{await page.waitForTimeout(900);await swipe(page,[2,520],[300,524]);await open(page);await settled(page);};
const showTopBar=(page:Page,on:boolean)=>page.evaluate(([key,on])=>{localStorage.setItem(key,String(on));window.dispatchEvent(new Event('storage'));},[topBarKey,on] as const);
const tabs=(page:Page)=>page.getByRole('navigation',{name:'Workspace navigation',exact:true}).getByRole('button');
const order=(page:Page)=>tabs(page).allInnerTexts();
const current=(page:Page)=>tabs(page).and(page.locator('[aria-current="page"]')).innerText();
const tab=(page:Page,name:string)=>tabs(page).filter({hasText:name}).first();
const hamburger=(page:Page)=>page.getByRole('button',{name:'Open hosts',exact:true});
/** Every button a person can reach in `scope`, by accessible name; the sheet's own paging chrome is not a control. */
const reachable=(scope:Locator)=>scope.evaluate(node=>[...node.querySelectorAll<HTMLElement>('button')]
  .filter(button=>button.getClientRects().length>0&&!button.closest('.workspace-tools-pager,.workspace-tools-dots'))
  .map(button=>button.getAttribute('aria-label')||button.textContent!.trim()));
/** The buttons of all three tabs, visiting each. */
async function reachableInMenu(page:Page) {
  const names=new Set<string>();
  for(const name of ['Agents','Workspaces','Connections']) {
    await tab(page,name).tap();
    for(const reached of await reachable(menu(page)))names.add(reached);
  }
  return names;
}

async function connectRemote(page:Page) {
  await connectAttachmentTerminal(page,{nonce:'d'.repeat(64),ready:'side-menu-ready'});
  await expect(header(page)).toHaveCount(0);
  // The password was just typed; the engine holds edge swipes for its typing window.
  await page.waitForTimeout(900);
}
async function openSession(page:Page) {
  await startLocalTerminal(page);
  await page.evaluate(()=>window.simpleShortcutOutput('hello\r\n'));
}

test.describe('phone, connected session',()=>{
  // A fresh phone: nothing is stored, so the defaults apply. 415x900 is the reference phone of the gesture work.
  test.use({viewport:{width:415,height:900},storageState:{cookies:[],origins:[]}});
  test.beforeEach(({},testInfo)=>{test.skip(testInfo.project.name!=='phone','The side menu is the phone layout.');});

  test('the connection list keeps the top bar; a session drops it and the hamburger',async({page})=>{
    await page.goto('/');
    await expect(header(page)).toBeVisible();
    await expect(hamburger(page)).toBeVisible();
    await openSession(page);
    await expect(header(page)).toHaveCount(0);
    await expect(hamburger(page)).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Workspace tools',exact:true})).toHaveCount(0);
  });

  test('the terminal gains the height of the top bar',async({page},testInfo)=>{
    await openSession(page);
    await showTopBar(page,true);
    await expect(header(page)).toBeVisible();
    const measure=()=>page.evaluate(async()=>{
      await new Promise(resolve=>setTimeout(resolve,400));
      const grid=document.querySelector('.terminal-canvas .xterm-screen')!.getBoundingClientRect();
      const {rows}=window.simpleShortcutResizes.at(-1)!;
      return {rows,rowPx:grid.height/rows,body:document.querySelector('.session-body')!.getBoundingClientRect().height,bar:document.querySelector('.workspace-header')?.getBoundingClientRect().height??0};
    });
    const withBar=await measure();
    await showTopBar(page,false);
    await expect(header(page)).toHaveCount(0);
    const without=await measure();
    const gained=without.rows-withBar.rows;
    testInfo.annotations.push({type:'rows',description:`${withBar.rows} -> ${without.rows} rows (+${gained}), top bar ${withBar.bar}px, body ${withBar.body} -> ${without.body}px at 415x900`});
    console.log(`terminal rows at 415x900: ${withBar.rows} with the top bar, ${without.rows} without it (+${gained}); top bar ${withBar.bar}px, session body ${withBar.body}px -> ${without.body}px`);
    expect(withBar.bar).toBeGreaterThan(40);
    expect(Math.abs(without.body-withBar.body-withBar.bar)).toBeLessThanOrEqual(1);
    expect(gained).toBeGreaterThanOrEqual(Math.floor(withBar.bar/withBar.rowPx));
    expect(gained).toBeLessThanOrEqual(Math.ceil(withBar.bar/withBar.rowPx));
    // The PTY has the new size too, not only the screen.
    expect(await page.evaluate(()=>window.simpleShortcutResizes.at(-1)!.rows)).toBe(without.rows);
  });

  test('a swipe from the left edge opens the one full-screen page, which closes by the opposite swipe, Escape and its close buttons',async({page},testInfo)=>{
    await connectRemote(page);
    const body=()=>page.locator('.session-body').boundingBox();
    const before=await body();
    await shut(page);
    await openBySwipe(page);
    await page.screenshot({path:testInfo.outputPath('menu-open.png')});
    // One page that fills the screen; no second, partial-width menu exists.
    expect(await menu(page).evaluate(node=>{const box=node.getBoundingClientRect();return {width:box.width,height:box.height,left:box.left};})).toEqual({width:415,height:900,left:0});
    await expect(page.getByTestId('side-menu')).toHaveCount(0);
    await expect(page.getByRole('dialog',{name:'Menu',exact:true})).toHaveCount(0);
    // It overlays the terminal: nothing around the terminal moved or resized.
    expect(await body()).toEqual(before);
    await swipe(page,[300,520],[40,524]);
    await shut(page);
    await openBySwipe(page);
    await page.keyboard.press('Escape');
    await shut(page);
    await openBySwipe(page);
    await page.getByRole('button',{name:'Return to terminal',exact:true}).first().tap();
    await shut(page);
    await openBySwipe(page);
    await tab(page,'Connections').tap();
    await page.getByRole('button',{name:'Close hosts',exact:true}).tap();
    await shut(page);
    expect(await body()).toEqual(before);
  });

  test('a short swipe that stops early leaves the page closed',async({page})=>{
    await connectRemote(page);
    await swipe(page,[2,520],[60,524]);
    await page.waitForTimeout(400);
    await shut(page);
    await swipe(page,[300,520],[40,524]);
    await page.waitForTimeout(300);
    await shut(page);
  });

  test('every control the top bar offered is reachable from the page',async({page},testInfo)=>{
    await connectRemote(page);
    await showTopBar(page,true);
    const bar=await reachable(header(page));
    await page.getByRole('button',{name:'Workspace tools',exact:true}).tap();
    const sheet=page.getByRole('dialog',{name:'Workspace tools',exact:true});
    const tools=await reachable(sheet);
    await page.keyboard.press('Escape');
    await showTopBar(page,false);
    await expect(header(page)).toHaveCount(0);
    await openBySwipe(page);
    const here=[...await reachableInMenu(page)];
    const former=[...new Set([...bar,...tools])].filter(name=>!['Workspace tools','Close Workspace tools'].includes(name));
    testInfo.annotations.push({type:'inventory',description:former.join(' | ')});
    console.log(`former top bar controls (${former.length}): ${former.join(' | ')}`);
    // Where the controls the page does not list under their old name went: the tabs, the search row and the Add a host row.
    const moved:Record<string,string>={'Open hosts':'Connections','Agents':'Agents navigation','New connection':'Jump to a host','Search saved hosts':'Jump to a host','Jump to':'Workspaces','Sessions':'Open session manager'};
    expect(former.filter(name=>!here.some(label=>label===name||label.startsWith(moved[name]??'\u0000')))).toEqual([]);
    expect(former).toEqual(expect.arrayContaining(['Switch terminal session','Terminal','Agent','Compose','Workspaces','Files','Sessions','Usage','Attach','Apple status','Transcript','Diff','Preview','Dictate','Devices','Default multiplexer','Preferences','Remote push settings','Open notification inbox','Open encrypted sync','Open shareable uploads','End Attachment fixture connection']));
  });

  test('each page entry does what its top bar twin did',async({page})=>{
    test.setTimeout(150_000);
    await connectRemote(page);
    // The composer keeps focus once opened, and focus in a text field blocks edge swipes by design.
    const choose=async(name:string,inTab:string,exact=true)=>{
      await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
      await openBySwipe(page);
      await tab(page,inTab).tap();
      await menu(page).getByRole('button',{name,exact}).first().tap();
    };
    await choose('Switch terminal session','Agents');
    await expect(page.getByRole('dialog',{name:'Switch terminal session',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    for(const [entry,dialog] of [['Preferences','Preferences'],['Remote push settings','Remote push settings'],['Open notification inbox','Notification inbox'],['Open encrypted sync','Encrypted sync'],['Open shareable uploads','Shareable uploads']] as const) {
      await choose(entry,'Connections');
      await expect(page.getByRole('dialog',{name:dialog,exact:true})).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await choose('Jump to a host','Connections',false);
    await expect(page.getByRole('dialog',{name:'Command palette',exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The session views are rows of the Workspaces tab; choosing one closes the page over the view.
    for(const [entry,view] of [['Files','files'],['Usage','usage'],['Attach','attachments']] as const) {
      await choose(entry,'Workspaces');
      await shut(page);
      await expect(page.locator('.workspace-footer')).toHaveAttribute('data-view',view);
      await page.getByRole('navigation',{name:'Tool navigation',exact:true}).getByRole('button',{name:'Return to terminal',exact:true}).tap();
    }
    await choose('Open session manager','Workspaces');
    await shut(page);
    await expect(page.locator('.workspace-footer')).toHaveAttribute('data-view','sessions');
    await page.getByRole('navigation',{name:'Tool navigation',exact:true}).getByRole('button',{name:'Return to terminal',exact:true}).tap();
    await choose('Compose','Agents');
    await expect(page.getByRole('textbox',{name:'Compose text',exact:true})).toBeVisible();
    await choose('Hide terminal keys','Agents');
    await expect(page.getByLabel('Terminal keys',{exact:true})).toHaveCount(0);
    // The Terminal | Agent switch is in the strip and keeps its state.
    await choose('Agent','Agents');
    await openBySwipe(page);
    await expect(menu(page).getByRole('button',{name:'Agent',exact:true})).toHaveAttribute('aria-pressed','true');
    await menu(page).getByRole('button',{name:'Terminal',exact:true}).first().tap();
    await shut(page);
    await choose('End Attachment fixture connection','Connections');
    await expect(page.getByRole('heading',{level:1})).toBeVisible();
    await expect(header(page)).toBeVisible();
  });

  test('a connected session lists Agents, Workspaces, Connections, opens on Agents and each tab on its own',async({page})=>{
    await connectRemote(page);
    await openBySwipe(page);
    expect(await order(page)).toEqual(['Agents','Workspaces','Connections']);
    expect(await current(page)).toBe('Agents');
    for(const name of ['Workspaces','Connections','Agents']) {
      await tab(page,name).tap();
      expect(await current(page)).toBe(name);
    }
  });

  test('the menu button opens a connected session on Agents, then on the tab the visit left',async({page})=>{
    await connectRemote(page);
    await showTopBar(page,true);
    await hamburger(page).tap();
    expect(await order(page)).toEqual(['Agents','Workspaces','Connections']);
    expect(await current(page)).toBe('Agents');
    await tab(page,'Workspaces').tap();
    expect(await current(page)).toBe('Workspaces');
    await page.getByRole('button',{name:'Return to terminal',exact:true}).first().click();
    await hamburger(page).tap();
    expect(await current(page)).toBe('Workspaces');
  });

  test('without a remote connection the page lists Connections first and opens on it',async({page})=>{
    await page.goto('/');
    await hamburger(page).tap();
    expect(await order(page)).toEqual(['Connections','Workspaces','Agents']);
    expect(await current(page)).toBe('Connections');
    await page.getByRole('button',{name:'Close hosts',exact:true}).tap();
    // A local terminal has no Agents to open on.
    await openSession(page);
    await page.waitForTimeout(900);
    await openBySwipe(page);
    expect(await order(page)).toEqual(['Connections','Workspaces','Agents']);
    expect(await current(page)).toBe('Connections');
  });

  test('the page does not open while the user types, composes or edits text',async({page})=>{
    await openSession(page);
    const closed=async()=>{await swipe(page,[2,520],[300,524]);await page.waitForTimeout(300);await shut(page);};
    await page.waitForTimeout(900);
    // A key typed a moment ago.
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('ls');
    await closed();
    // A soft-keyboard composition in progress.
    await page.waitForTimeout(900);
    await page.locator('.xterm-helper-textarea').evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionstart')));
    await closed();
    await page.locator('.xterm-helper-textarea').evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend')));
    // Focus in a text field: the composer.
    await page.waitForTimeout(900);
    await openBySwipe(page);
    await menu(page).getByRole('button',{name:'Compose',exact:true}).tap();
    await page.getByRole('textbox',{name:'Compose text',exact:true}).focus();
    await closed();
    // A touch that starts inside the screen is a scroll or a selection, never an edge swipe.
    await page.getByRole('textbox',{name:'Compose text',exact:true}).evaluate(node=>node.blur());
    await page.waitForTimeout(1500);
    await swipe(page,[120,520],[400,524]);
    await page.waitForTimeout(300);
    await shut(page);
    // None of that made the gesture unusable: with nothing in progress it opens.
    await page.waitForTimeout(1500);
    await openBySwipe(page);
  });

  test('opening the page leaves the keyboard closed',async({page})=>{
    await connectRemote(page);
    await openBySwipe(page);
    expect(await page.evaluate(()=>document.activeElement?.closest('.terminal-canvas')===null)).toBe(true);
    await page.getByRole('button',{name:'Return to terminal',exact:true}).first().tap();
    await shut(page);
    expect(await page.evaluate(()=>document.activeElement?.matches('input,textarea,[contenteditable]')??false)).toBe(false);
  });

  test('the Show top bar preference brings the bar back',async({page})=>{
    await openSession(page);
    await page.waitForTimeout(900);
    await openBySwipe(page);
    await menu(page).getByRole('button',{name:'Preferences',exact:true}).tap();
    await openPreferenceCategory(page,'Appearance');
    const toggle=page.getByRole('checkbox',{name:'Show the top bar on phones',exact:true});
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.keyboard.press('Escape');
    await expect(header(page)).toBeVisible();
    await expect(hamburger(page)).toBeVisible();
    await expect(page.locator('.sidebar-session')).toHaveCount(0);
    expect(await page.evaluate(key=>localStorage.getItem(key),topBarKey)).toBe('true');
  });

  test('screen-reader mode keeps a visible menu button and no gesture-only access',async({page})=>{
    await page.addInitScript(()=>localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,screenReader:true})));
    await openSession(page);
    await expect(header(page)).toBeVisible();
    await expect(hamburger(page)).toBeVisible();
    await swipe(page,[2,520],[300,524]);
    await page.waitForTimeout(300);
    await shut(page);
    await hamburger(page).tap();
    await open(page);
  });

  test('the page and the terminal start below the status bar',async({page})=>{
    const protocol=await page.context().newCDPSession(page);
    await protocol.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:62}});
    await openSession(page);
    expect(await page.locator('.session-body').evaluate(node=>node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(62);
    await page.waitForTimeout(900);
    await openBySwipe(page);
    expect(await menu(page).locator('.sidebar-session').evaluate(node=>node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(62);
  });
});

test('desktop and wide layouts keep the top bar and the sidebar as they were in a session',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Phones are covered above.');
  await connectAttachmentTerminal(page,{nonce:'e'.repeat(64),ready:'side-menu-ready'});
  await expect(header(page)).toBeVisible();
  await expect(page.locator('.sidebar-session')).toHaveCount(0);
  expect(await order(page)).toEqual(['Connections','Workspaces','Agents']);
  expect(await current(page)).toBe('Connections');
});
