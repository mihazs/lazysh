// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {chooseWorkspaceTool, connectAuto, connectForNavigation, enableTransports, mocks, openConnection} from './test/appHarness';
import {t, uiI18n} from './i18n/core';
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {act, cleanup, render, screen, waitFor, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import canonicalBedMode from '../../../brand/lazysh/svg/icon-gradient.svg';
import {aboutLocales} from './test/aboutData';
import App from "./App";
import {setGestureInsets, unknownInsets} from './gestureInsets';

it('opens AI account usage for the exact connected terminal and returns without duplicate history',async()=>{
  const user=await connectForNavigation('usage-owner');
  const owner=mocks.terminalPaneProps.mock.lastCall?.[0].session;
  expect(mocks.accountUsageSession).toHaveBeenLastCalledWith('usage-owner');
  const bar=screen.getByRole('button',{name:'Open AI account usage'});
  expect(bar.closest('.workspace-footer')).not.toBeNull();await user.click(bar);await user.click(bar);
  expect(await screen.findByRole('region',{name:'AI account usage'})).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Back'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.terminalPaneProps.mock.lastCall?.[0]).toMatchObject({session:owner,active:true});
  await waitFor(()=>expect(mocks.backButton).toBeUndefined());
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.api.write).not.toHaveBeenCalled();
});

it('restores the actual Agents origin when returning from usage',async()=>{
  const user=await connectForNavigation('agent-origin');
  await user.click(screen.getByRole('button',{name:t('navigationAgents')}));
  await user.click(screen.getByRole('button',{name:'Open AI account usage'}));
  await user.click(await screen.findByRole('button',{name:'Back'}));
  expect(screen.getByRole('button',{name:t('navigationAgents')}).getAttribute('aria-current')).toBe('page');
  expect(screen.getByText('Agent companion').closest('[hidden]')).toBeNull();
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);expect(mocks.api.disconnect).not.toHaveBeenCalled();
});

it('dismisses the top dialog before navigating and releases native Back at the root',async()=>{
  const user=await connectForNavigation('back-owner');
  await user.click(screen.getByRole('button',{name:'Open AI account usage'}));
  await waitFor(()=>expect(mocks.backButton).toBeTypeOf('function'));
  await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  await screen.findByRole('dialog',{name:'Workspace tools'});
  act(()=>mocks.backButton?.({canGoBack:false}));
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('region',{name:'AI account usage'})).toBeTruthy();
  const retired=mocks.backButton;
  act(()=>mocks.backButton?.({canGoBack:false}));
  await screen.findByText('Live SSH terminal');
  await waitFor(()=>expect(mocks.backButton).toBeUndefined());
  act(()=>retired?.({canGoBack:false}));
  expect(screen.getByText('Live SSH terminal')).toBeTruthy();expect(mocks.api.disconnect).not.toHaveBeenCalled();
});

it('gives a visible dialog priority over the terminal local Back callback',async()=>{
  const user=await connectForNavigation('local-back');
  const publish=mocks.terminalPaneProps.mock.lastCall?.[0].onBackChange;
  const close=vi.fn(()=>true);act(()=>publish('local-back',close));
  await waitFor(()=>expect(mocks.backButton).toBeTypeOf('function'));
  await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  act(()=>mocks.backButton?.({canGoBack:false}));
  expect(screen.queryByRole('dialog')).toBeNull();expect(close).not.toHaveBeenCalled();
  act(()=>mocks.backButton?.({canGoBack:false}));expect(close).toHaveBeenCalledTimes(1);
  act(()=>publish('local-back',null));
  await waitFor(()=>expect(mocks.backButton).toBeUndefined());
  expect(mocks.api.write).not.toHaveBeenCalled();expect(mocks.api.disconnect).not.toHaveBeenCalled();
});

it.each([false,true])('returns to the opening session or skips its closed origin: %s',async closeOrigin=>{
  const user=await connectForNavigation('origin');
  mocks.api.connect.mockResolvedValue({sessionId:'other'});
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));
  await user.type(screen.getByLabelText('Password'),'temporary-secret');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(screen.getAllByRole('tab')).toHaveLength(2));
  await user.click(screen.getAllByRole('tab')[0]);
  await user.click(screen.getByRole('button',{name:'Open AI account usage'}));
  await user.click(screen.getAllByRole('tab')[1]);
  expect(mocks.accountUsageSession).toHaveBeenLastCalledWith('other');
  if(closeOrigin){await user.click(within(screen.getAllByRole('tab')[0].closest('.session-tab') as HTMLElement).getByRole('button',{name:'Disconnect Home'}));await waitFor(()=>expect(screen.getAllByRole('tab')).toHaveLength(1));}
  await user.click(screen.getByRole('button',{name:'Return to terminal'}));
  expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true');
  expect(mocks.accountUsageSession).toHaveBeenLastCalledWith(closeOrigin?'other':'origin');
  expect(mocks.api.connect).toHaveBeenCalledTimes(2);expect(mocks.api.disconnect).toHaveBeenCalledTimes(closeOrigin?1:0);
});

it('opens the existing Agents sidebar installer from account usage setup without starting installation',async()=>{
  mocks.accountUsageCompanionRequired=true;mocks.realAgents=true;
  mocks.api.connect.mockResolvedValue({sessionId:'usage-needs-companion'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');await user.click(screen.getByRole('button',{name:'Open AI account usage'}));
  await user.click(await screen.findByRole('button',{name:'Install or update companion'}));
  expect((await screen.findByRole('button',{name:'Install companion'})).closest('[hidden]')).toBeNull();
  expect(screen.getByRole('button',{name:t('navigationAgents')}).getAttribute('aria-current')).toBe('page');
  expect(mocks.invoke.mock.calls.some(([command])=>command==='companion_install')).toBe(false);
  expect(mocks.api.disconnect).not.toHaveBeenCalled();
});

it('reauthenticates only host tools from disconnected Mosh account usage and refreshes after success',async()=>{
  enableTransports();mocks.accountUsageDisconnected=true;
  mocks.api.connectMosh.mockResolvedValue({sessionId:'quota-mosh'});
  mocks.api.restoreHostTools.mockResolvedValue({schemaVersion:1,status:'restored'});
  const user=await connectAuto();await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Open AI account usage'}));
  await user.click(await screen.findByRole('button',{name:t('accountUsageRestore')}));
  const dialog=await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Password'),'explicit-quota-recovery');
  expect(mocks.api.restoreHostTools).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button',{name:t('hostToolsRestore')}));
  await waitFor(()=>expect(mocks.accountUsageRefresh).toHaveBeenCalledOnce());
  expect(mocks.api.restoreHostTools).toHaveBeenCalledExactlyOnceWith('quota-mosh',{password:'explicit-quota-recovery'},{useSavedCredentials:false});
  expect(mocks.api.restoreFileTransfer).not.toHaveBeenCalled();expect(mocks.api.write).not.toHaveBeenCalled();
});

it('opens attachments from the live toolbar and retires held callbacks after navigation or unmount',async()=>{
  mocks.api.connect.mockResolvedValue({sessionId:'toolbar-attachments'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  const open=mocks.terminalPaneProps.mock.lastCall![0].onOpenAttachments;
  expect(open).toBeTypeOf('function');
  await act(async()=>open());await screen.findByText('Attach to this host');
  await chooseWorkspaceTool(user,'Usage');
  await screen.findByRole('button',{name:'Use latest report for Watch'});
  await act(async()=>open());expect(screen.queryByText('Attach to this host')).toBeNull();
  cleanup();await act(async()=>open());expect(mocks.api.write).not.toHaveBeenCalled();
});

it('uses the canonical Bed Mode mark decoratively beside one app name',async()=>{
  const {container}=render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  const brand=container.querySelector('.brand')!;
  const mark=brand.querySelector('img')!;
  expect(mark).not.toBeNull();
  expect(mark.getAttribute('src')).toBe(canonicalBedMode);
  expect(mark.getAttribute('alt')).toBe('');
  expect(mark.getAttribute('aria-hidden')).toBe('true');
  expect(within(brand as HTMLElement).queryAllByRole('img',{name:/lazysh|Bed Mode/})).toHaveLength(0);
  expect(brand.textContent?.match(/lazysh/g)).toHaveLength(1);
  expect(brand.textContent).not.toContain('l_');
});

it('keeps the current build version on the same About action through locale changes', async () => {
  render(<App/>);
  const button = await screen.findByRole('button', { name: 'About lazysh · 2.3.4' });
  try {
    for (const labels of aboutLocales) {
      await act(async () => { await uiI18n.changeLanguage(labels.locale); });
      expect(screen.getByRole('button', { name: `${labels.region} · 2.3.4` })).toBe(button);
    }
  } finally { await act(async () => { await uiI18n.changeLanguage('en'); }); }
});

it.each(['LOCAL_LAUNCH_UNAVAILABLE','LOCAL_LAUNCH_WARM_UNSUPPORTED','LOCAL_LAUNCH_DIRECTORY_UNSUPPORTED','HOST_LAUNCH_MISSING','HOST_LAUNCH_AMBIGUOUS','HOST_LAUNCH_CHANGED','HOST_LAUNCH_BUSY','HOST_LAUNCH_INVALID'])('keeps an unrelated raw global sentinel lookalike verbatim: %s',async raw=>{
  render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  try {
    await act(async()=>{window.dispatchEvent(new CustomEvent('lazysh-error',{detail:raw}));});
    for(const locale of ['en','pt-BR','es']) {
      await act(async()=>{await uiI18n.changeLanguage(locale);});
      expect(screen.getByRole('alert').querySelector('span')?.textContent).toBe(raw);
    }
  } finally { await act(async()=>{await uiI18n.changeLanguage('en');}); }
});

it('starts Workspace tools on seven primary destinations with the other tool groups as labelled pages',async()=>{
  const stored=new Map<string,string>();
  vi.stubGlobal('localStorage',{setItem:(key:string,value:string)=>stored.set(key,value),getItem:(key:string)=>stored.get(key)??null,removeItem:(key:string)=>stored.delete(key),length:0});
  const user=await connectForNavigation('short-tools');
  await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  const dialog=screen.getByRole('dialog',{name:'Workspace tools'});
  expect(dialog.querySelectorAll('details')).toHaveLength(0);
  const carousel=within(dialog).getByRole('region',{name:'Workspace tool pages'});
  expect(carousel.getAttribute('aria-roledescription')).toBe('carousel');
  const tabs=within(carousel).getAllByRole('tab');
  expect(tabs.map(tab=>tab.getAttribute('aria-label'))).toEqual(['Session views','More tools','Connections','Application options']);
  expect(tabs.map(tab=>tab.getAttribute('aria-selected'))).toEqual(['true','false','false','false']);
  expect(tabs.map(tab=>tab.tabIndex)).toEqual([0,-1,-1,-1]);
  const current=within(carousel).getByRole('tabpanel');
  expect(current.getAttribute('aria-label')).toBe('Session views, 1 of 4');
  expect(current.getAttribute('aria-roledescription')).toBe('page');
  expect(within(current).getAllByRole('button').map(button=>button.textContent)).toEqual(['Workspaces','Terminal','Agents','Files','Sessions','Usage','Attach']);
  expect(within(dialog).queryByRole('button',{name:'Transcript'})).toBeNull();
  expect((within(carousel).getByRole('button',{name:'Previous tools page'}) as HTMLButtonElement).disabled).toBe(true);
  const end=within(dialog).getByRole('button',{name:'End Home connection'});
  expect(end.closest('.workspace-tools-carousel')).toBeNull();expect(end.classList.contains('danger-button')).toBe(true);
  await user.click(within(carousel).getByRole('button',{name:'Next tools page'}));
  expect(within(carousel).getByRole('tabpanel').getAttribute('aria-label')).toBe('More tools, 2 of 4');
  expect(within(within(carousel).getByRole('tabpanel')).getAllByRole('button').map(button=>button.textContent)).toEqual(['Apple status','Transcript','Diff','Preview','Dictate','Devices']);
  // Arrow keys move the selected page tab and its focus; Home and End reach the ends.
  tabs[1].focus();await user.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(tabs[2]);expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  expect(within(within(carousel).getByRole('tabpanel')).getByRole('button',{name:'New connection'})).toBeTruthy();
  await user.keyboard('{End}');expect(document.activeElement).toBe(tabs[3]);
  expect((within(carousel).getByRole('button',{name:'Next tools page'}) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard('{Home}');expect(document.activeElement).toBe(tabs[0]);
  await user.click(tabs[1]);
  await user.click(within(dialog).getByRole('button',{name:'Transcript'}));
  expect(screen.queryByRole('dialog',{name:'Workspace tools'})).toBeNull();
  // Reopening the sheet returns to the page last turned to, which outlives this session.
  await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  const reopened=within(screen.getByRole('dialog',{name:'Workspace tools'})).getByRole('tabpanel');
  expect(reopened.getAttribute('aria-label')).toBe('More tools, 2 of 4');
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.api.write).not.toHaveBeenCalled();
  // A restarted app with a new connection still opens on that page.
  cleanup();
  const restarted=await connectForNavigation('short-tools-restarted');
  await restarted.click(screen.getByRole('button',{name:'Workspace tools'}));
  expect(within(screen.getByRole('dialog',{name:'Workspace tools'})).getByRole('tabpanel').getAttribute('aria-label')).toBe('More tools, 2 of 4');
});

it('exposes remote push settings from Workspace tools',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Workspace tools'}));
  await user.click(screen.getByRole('button',{name:'Remote push settings'}));
  expect(await screen.findByText('Native push registration controls')).toBeTruthy();
});

it('opens Apple status for the exact active session and routes review to agents',async()=>{
  mocks.api.connect.mockResolvedValue({sessionId:'apple-current'});
  const user=await openConnection();
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await chooseWorkspaceTool(user,'Apple status');
  expect(await screen.findByText('Apple controls for apple-current')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Review Apple approval'}));
  expect(await screen.findByText('Agent companion')).toBeTruthy();
});

it('runs workspace tools and application actions from the keyboard-only command palette',async()=>{
  mocks.api.connect.mockResolvedValue({sessionId:'palette-session'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await user.keyboard('{Control>}k{/Control}');
  const search=await screen.findByRole('combobox',{name:'Search hosts, sessions and commands'});
  expect(within(screen.getByRole('listbox')).getByRole('option',{name:/^Home.*Current$/})).toBeTruthy();
  await user.keyboard('usage{Enter}');
  await screen.findByRole('button',{name:'Use latest report for Watch'});
  expect(screen.queryByRole('dialog',{name:'Command palette'})).toBeNull();
  expect(search.isConnected).toBe(false);
  await user.keyboard('{Control>}k{/Control}');
  await user.keyboard('prefs');
  expect(screen.getAllByRole('option')[0].textContent).toContain('Preferences');
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('dialog',{name:'Preferences'})).toBeTruthy();
  await user.keyboard('{Escape}');
  await user.keyboard('{Control>}k{/Control}');
  await user.keyboard('terminal{Escape}');
  expect(screen.queryByRole('dialog',{name:'Command palette'})).toBeNull();
  await screen.findByRole('button',{name:'Use latest report for Watch'});
});

it('honors the connection shortcut and protects credential dialogs from global shortcuts',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.keyboard('{Control>}n{/Control}');
  expect(screen.getByLabelText('Search hosts, sessions and commands')).toBeTruthy();
  await user.click(screen.getByRole('option',{name:/Home.*dev@home.local/}));
  await user.click(screen.getByLabelText('Password'));
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.queryByLabelText('Search hosts, sessions and commands')).toBeNull();
  expect(screen.getByLabelText('Password')).toBeTruthy();
});

it('switches tabs by numbered shortcut and accepts gestures only from the active session',async()=>{
  mocks.api.connect.mockResolvedValueOnce({sessionId:'first'}).mockResolvedValueOnce({sessionId:'second'});
  const user=await openConnection();
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));
  await user.type(screen.getByLabelText('Password'),'second-secret');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(screen.getAllByRole('tab',{name:'Home'})).toHaveLength(2));
  const tabs=()=>screen.getAllByRole('tab',{name:'Home'});
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  act(()=>window.dispatchEvent(new CustomEvent('lazysh-terminal-action',{detail:{sessionId:'first',action:'nextSession'}})));
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  act(()=>window.dispatchEvent(new CustomEvent('lazysh-terminal-action',{detail:{sessionId:'second',action:'nextSession'}})));
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  await user.keyboard('{Control>}2{/Control}');
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  await user.keyboard('{Control>}o{/Control}');
  expect(screen.getByText('Switch terminal session')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Close Switch terminal session'}));
  await user.keyboard('{Control>}w{/Control}');
  await waitFor(()=>expect(mocks.api.disconnect).toHaveBeenCalledWith('second'));
  expect(screen.getAllByRole('tab',{name:'Home'})).toHaveLength(1);
});

it('uses the existing guarded dialog shell for long mobile tasks and keeps choices separate', async () => {
  const user=userEvent.setup(); render(<App />);
  const preferences=await screen.findByRole('button',{name:'Preferences'});
  await user.click(preferences);
  const dialog=screen.getByRole('dialog',{name:'Preferences'});
  expect(dialog.parentElement?.getAttribute('data-mobile-presentation')).toBe('page');
  expect(dialog.querySelector('.dialog-content')).not.toBeNull();
  const connections=within(dialog).getByRole('button',{name:'Connections'});
  expect(within(dialog).queryByRole('region',{name:'Default multiplexer'})).toBeNull();
  await user.click(connections);
  expect(within(dialog).getByRole('region',{name:'Default multiplexer'})).toBeTruthy();
  await user.click(within(dialog).getByRole('button',{name:'Back'}));
  const security=within(dialog).getByRole('button',{name:'Security and app lock'});
  expect(within(dialog).queryByRole('region',{name:'App lock settings'})).toBeNull();
  await user.click(security);
  expect(within(dialog).getByRole('region',{name:'App lock settings'})).toBeTruthy();
  expect(within(dialog).getByText(/Require device authentication when returning/)).toBeTruthy();
  within(dialog).getByRole('button',{name:'Close Preferences'}).focus();
  await user.keyboard('{Escape}'); expect(screen.getByRole('dialog',{name:'Preferences'})).toBe(dialog);
  await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(preferences);
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));
  const connection=screen.getByRole('dialog',{name:'Connect to Home'});
  expect(connection.parentElement?.getAttribute('data-mobile-presentation')).toBe('page');
  await user.click(within(connection).getByRole('button',{name:'Close Connect to Home'}));
  expect(screen.queryByRole('dialog')).toBeNull();
});

/** #1380 and #1435: on a phone in gesture navigation the left handle opens the navigation page, and Android Back always closes it first. */
describe('the navigation page and Android Back on a phone',()=>{
  const phone=()=>vi.stubGlobal('matchMedia',vi.fn((query:string)=>({matches:query.includes('max-width')||query.includes('coarse'),media:query,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  const page=()=>screen.getByRole('complementary',{name:'Hosts and connections'});
  const handle=()=>document.querySelector<HTMLElement>('[data-gesture-handle="left"]');
  beforeEach(()=>{phone();act(()=>setGestureInsets({left:32,right:32,bottom:48,mandatoryBottom:48,navigation:'gesture'}));});
  afterEach(()=>{act(()=>setGestureInsets(unknownInsets));});

  it('shows the left handle while the page is closed and hides it while the page is open, and Back closes the page',async()=>{
    const user=await connectForNavigation('handle-owner');
    await waitFor(()=>expect(handle()).not.toBeNull());
    expect(page().classList.contains('sidebar-open')).toBe(false);
    await user.click(handle()!);
    expect(page().classList.contains('sidebar-open')).toBe(true);
    expect(handle()).toBeNull();
    expect(mocks.backButton).toBeTypeOf('function');
    act(()=>mocks.backButton?.({canGoBack:false}));
    expect(page().classList.contains('sidebar-open')).toBe(false);
    await waitFor(()=>expect(handle()).not.toBeNull());
    expect(mocks.api.disconnect).not.toHaveBeenCalled();
  });

  it('has a Back handler registered whenever the page is open, closes it every time, and never leaves the app',async()=>{
    const user=await connectForNavigation('cycle-owner');
    await waitFor(()=>expect(handle()).not.toBeNull());
    for(let cycle=0;cycle<100;cycle++){
      await user.click(handle()!);
      expect(page().classList.contains('sidebar-open'),`cycle ${cycle}: open`).toBe(true);
      // Android leaves the app on a Back that has no handler, so the handler must exist the moment the page can be seen.
      expect(mocks.backButton,`cycle ${cycle}: handler`).toBeTypeOf('function');
      act(()=>mocks.backButton?.({canGoBack:false}));
      expect(page().classList.contains('sidebar-open'),`cycle ${cycle}: closed`).toBe(false);
      await waitFor(()=>expect(mocks.backButton).toBeUndefined());
      await waitFor(()=>expect(handle()).not.toBeNull());
    }
    expect(mocks.api.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText('Live SSH terminal')).toBeTruthy();
    // A hundred open and close cycles take about 5 s: past the default timeout on a loaded runner.
  },30_000);
});
