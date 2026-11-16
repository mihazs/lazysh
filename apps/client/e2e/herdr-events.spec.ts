import {expect,test,type Page} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountHerdrEvents} from './fixtures/HerdrEventsHarness';
declare global {interface Window {herdrEvents:ReturnType<typeof mountHerdrEvents>;}}

/** Mounts the Herdr view (unless `view` is off), monitor and inbox with monitoring and system notifications already on. */
async function mount(page:Page,watch:'live'|'old'|'off',locale='en',view=true) {
  await page.clock.install();
  await openLocalizedApp(page,locale);
  // The plugin trusts the browser's own permission unless it is `default`; ask the bridge instead, as the native app does.
  await page.evaluate(()=>{Object.defineProperty(window.Notification,'permission',{configurable:true,get:()=>'default'});localStorage.setItem('lazysh.inbox.v1',JSON.stringify({version:1,monitoring:true,notifications:true,rows:[],latest:{}}));});
  await page.evaluate(async options=>{const {mountHerdrEvents}=await import('/e2e/fixtures/HerdrEventsHarness.tsx');window.herdrEvents=mountHerdrEvents({...options,status:'working'});},{watch,view});
  await expect(view?page.getByRole('button',{name:'Development',exact:false}).first():page.getByRole('region',{name:'Agent inbox',exact:true})).toBeVisible();
}
const commands=(page:Page,command:string)=>page.evaluate(command=>window.herdrEvents.calls.filter(call=>call.command===command).length,command);
const reads=(page:Page)=>commands(page,'herdr_tree');
const notifications=(page:Page)=>page.evaluate(()=>window.herdrEvents.calls.filter(call=>call.command==='notify_agent_attention').map(call=>call.args));
const noSideways=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth);
/** The inbox lists the blocked Codex of `builder` once under Needs you, with one system notification for it. */
async function expectBlockedCodex(page:Page) {
  const inbox=page.getByRole('region',{name:'Agent inbox',exact:true});
  const row=inbox.getByRole('article',{name:'Codex'});
  await expect(row).toContainText('app');
  await expect(row).toContainText('builder');
  await expect(inbox.getByRole('heading',{level:4})).toHaveText([/^Needs you\s*1$/]);
  await expect.poll(()=>notifications(page)).toHaveLength(1);
  expect((await notifications(page))[0]).toMatchObject({sessionId:'herdr-events-host',agent:'Codex',project:'/srv/app'});
  return inbox;
}
test.afterEach(async({page})=>{await page.evaluate(()=>window.herdrEvents?.dispose());});

test('a live stream replaces the five second read, shows a blocked agent at once and puts it in the inbox once',async({page})=>{
  await mount(page,'live');
  const note=page.locator('.herdr-watch-note');
  await expect(note).toHaveText("Live: Herdr's changes appear as they happen.");
  await expect(note).toHaveAttribute('data-watch','live');
  expect(await reads(page)).toBe(1);
  await page.clock.runFor(5000*11);
  expect(await reads(page)).toBe(1);
  // The monitor and the view follow the same server: one channel.
  expect(await commands(page,'agent_watch_start')).toBe(1);
  // The agent blocks: one frame, one read by the view and one by the inbox to name the agent's session, and the row says so without waiting for a tick.
  await page.evaluate(()=>{window.herdrEvents.setStatus('blocked');window.herdrEvents.emit({type:'status',paneId:'w1:p2',workspaceId:'w1',status:'blocked',agent:'codex',cwd:'/srv/app'});});
  await page.clock.runFor(300);
  await expect(page.getByRole('button',{name:/Development.*Needs attention/})).toBeVisible();
  expect(await reads(page)).toBe(3);
  const inbox=await expectBlockedCodex(page);
  // The same status again is not a second event, and finishing in a hidden tab is recorded without a notification.
  await page.evaluate(()=>window.herdrEvents.emit({type:'status',paneId:'w1:p2',workspaceId:'w1',status:'done',agent:'codex',cwd:'/srv/app'}));
  await expect(inbox.getByRole('heading',{level:4})).toHaveText([/^Done\s*1$/]);
  expect(await notifications(page)).toHaveLength(1);
  expect(await noSideways(page)).toBe(true);
});

test('with no Herdr view shown the inbox follows the host\'s Herdr itself, records a blocked agent once and closes the stream with monitoring',async({page})=>{
  await mount(page,'live','en',false);
  await expect.poll(()=>commands(page,'agent_watch_start')).toBe(1);
  expect(await commands(page,'multiplexer_sessions')).toBe(1);
  expect(await reads(page)).toBe(0);
  await expect(page.locator('.herdr-watch-note')).toHaveCount(0);
  await page.evaluate(()=>window.herdrEvents.emit({type:'status',paneId:'w1:p2',workspaceId:'w1',status:'blocked',agent:'codex',cwd:'/srv/app'}));
  const inbox=await expectBlockedCodex(page);
  // No view read the tree, so the inbox read it once to name the agent's session.
  expect(await reads(page)).toBe(1);
  await page.clock.runFor(15000*2);
  expect(await commands(page,'agent_watch_start')).toBe(1);
  expect(await commands(page,'agent_watch_stop')).toBe(0);
  expect(await noSideways(page)).toBe(true);
  // Turning monitoring off closes the stream.
  const settings=inbox.locator('details.inbox-settings');
  if(await settings.getAttribute('open')===null)await settings.locator('summary').click();
  await inbox.getByRole('checkbox',{name:'Monitor connected hosts'}).uncheck();
  await expect.poll(()=>commands(page,'agent_watch_stop')).toBe(1);
});

test('a companion that cannot stream leaves the view polling and says so',async({page})=>{
  await mount(page,'old');
  const note=page.locator('.herdr-watch-note');
  await expect(note).toHaveText('Live updates need a newer host companion and a Herdr that supports them, so this view refreshes every 5 seconds.');
  await expect(note).toHaveAttribute('data-watch','unsupported');
  const before=await reads(page);
  await page.clock.runFor(5000*3);
  expect(await reads(page)).toBe(before+3);
  expect(await noSideways(page)).toBe(true);
});

test('a channel that cannot open keeps the five second read and shows the delayed note',async({page})=>{
  await mount(page,'off');
  await expect(page.locator('.herdr-watch-note')).toHaveText('Live updates are unavailable, so this view refreshes every 5 seconds.');
  const before=await reads(page);
  await page.clock.runFor(5000*2);
  expect(await reads(page)).toBeGreaterThanOrEqual(before+2);
});

for(const [locale,live,polling] of [['pt-BR','Ao vivo: as mudanças do Herdr aparecem assim que acontecem.','As atualizações ao vivo não estão disponíveis; esta visão atualiza a cada 5 segundos.'],
  ['es','En vivo: los cambios de Herdr aparecen en cuanto ocurren.','Las actualizaciones en vivo no están disponibles; esta vista se actualiza cada 5 segundos.']] as const)
  test(`the live and polling notes read in ${locale}`,async({page})=>{
    await mount(page,'live',locale);
    await expect(page.locator('.herdr-watch-note')).toHaveText(live);
    await page.evaluate(()=>window.herdrEvents.dispose());
    await page.evaluate(async()=>{const {mountHerdrEvents}=await import('/e2e/fixtures/HerdrEventsHarness.tsx');window.herdrEvents=mountHerdrEvents({watch:'off',status:'working'});});
    await expect(page.locator('.herdr-watch-note')).toHaveText(polling);
    expect(await noSideways(page)).toBe(true);
  });
