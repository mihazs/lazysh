import {LocalUiError} from './i18n/localError';
import {t,uiI18n} from './i18n/core';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Host, TransportMode } from "./bridge";
import type {DesktopMux} from './useDesktopLaunch';
import canonicalBedMode from '../../../brand/lazysh/svg/icon-gradient.svg';
import {aboutLocales} from './test/aboutData';
import {transcriptAgents,type TranscriptAgentId} from './transcriptSources';
import {tmuxJumpSnapshot as navigationSnapshot} from './test/tmuxJumpData';
import {tmuxChatReply,tmuxChatReaderSource,tmuxChatReaderPage} from './test/tmuxChat';
vi.mock('../package.json',()=>({default:{version:'2.3.4'}}));

const mocks = vi.hoisted(() => ({
  api: {
    listHosts: vi.fn(),
    saveHost: vi.fn(),
    deleteHost: vi.fn(),
    trustHostKey: vi.fn(),
    connect: vi.fn(),
    restoreFileTransfer: vi.fn(),
    restoreHostTools: vi.fn(),
    connectLocal: vi.fn(),
    connectMosh: vi.fn(),
    connectEt: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    ackOutput: vi.fn(),
    adoptSession: vi.fn(),
    muxSessions: vi.fn(),
    attachTmux: vi.fn(),
    attachMultiplexer: vi.fn(),
    attachDefaultMultiplexer: vi.fn(),
    tmuxJumpSnapshot: vi.fn(),
    tmuxJump: vi.fn(),
  },
  terminal: { write: vi.fn(), dispose: vi.fn() },
  createTerminal: vi.fn(),
  invoke: vi.fn(),
  accountUsageSession: vi.fn(),
  accountUsageRefresh: vi.fn(),
  accountUsageDisconnected: false,
  terminalPaneProps: vi.fn(),
  appleProps: vi.fn(),
  voiceProps: vi.fn(),
  realAgents:false,
  launchReceipt: null as string|null,
  hostLaunchReceipt: null as string|null,
  prepareError: null as string|null,
  launchEvent: undefined as undefined|((event:{payload:unknown})=>void),
  lockEvent: undefined as undefined | ((event: { payload: unknown }) => void),
}));
let generationBase=0;
const unlockedStatus = () => ({initialized:true,supported:true,reason:'',enabled:false,locked:false,generation:String(generationBase),nonce:'a'.repeat(64)});
vi.mock("@tauri-apps/api/core", () => ({ isTauri:()=>true, invoke: (...request:[string,unknown?,unknown?]) => {
  const [command]=request;
  if(command==='app_lock_status')return Promise.resolve(unlockedStatus());
  if(command==='app_lock_ready')return Promise.resolve();
  if(command==='desktop_launch_read'){const directoryReceipt=mocks.launchReceipt,hostReceipt=mocks.hostLaunchReceipt;mocks.launchReceipt=null;mocks.hostLaunchReceipt=null;return Promise.resolve({directoryReceipt,hostReceipt,notice:null});}
  if(command==='ui_locale_status')return Promise.resolve({nativeAuthority:false});
  return mocks.invoke(...request);
} }));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async (name:string,callback:(event:{payload:unknown})=>void)=>{
  if(name==='lazysh-app-lock')mocks.lockEvent=callback;
  if(name==='lazysh-desktop-launch')mocks.launchEvent=callback;
  return()=>{if(mocks.lockEvent===callback)mocks.lockEvent=undefined;if(mocks.launchEvent===callback)mocks.launchEvent=undefined;};
})}));
vi.mock("./bridge", () => ({ native: true, api: mocks.api }));
vi.mock('./useAccountUsage',()=>({useAccountUsage:(sessionId:string|null)=>{mocks.accountUsageSession(sessionId);return {response:{schemaVersion:1,state:mocks.accountUsageDisconnected?'disconnected':'ready',source:'builtin',report:{primary:null,entries:[]}},refreshing:false,refresh:mocks.accountUsageRefresh,entry:null,select:()=>{}};}}));
vi.mock("./terminal", () => ({ createTerminal: () => mocks.createTerminal() }));
vi.mock("./TerminalPane", () => ({
  default: (props: { active: boolean; onOpenAttachments?:()=>void }) => {
    mocks.terminalPaneProps(props);
    return props.active ? <div>Live SSH terminal</div> : null;
  },
}));
vi.mock('./AgentPanel',async original=>{
  const actual=await original<typeof import('./AgentPanel')>();
  return {...actual,default:(props:React.ComponentProps<typeof actual.AgentPanel>)=>mocks.realAgents?<actual.AgentPanel {...props}/>:<div>Agent companion</div>};
});
vi.mock('./PushSettingsPanel',()=>({default:()=> <div>Native push registration controls</div>}));
vi.mock('./AppleStatusPanel',async()=>{
  const {useState}=await import('react');
  return {default:(props:{sessionId:string;usage?:unknown;onReview:()=>void})=>{
    const [sharing,setSharing]=useState(false);mocks.appleProps(props);
    return <div>Apple controls for {props.sessionId}<button onClick={props.onReview}>Review Apple approval</button><button onClick={()=>setSharing(true)}>Start test Apple sharing</button>{sharing && <p>Apple sharing remains active</p>}</div>;
  }};
});
vi.mock('./UsagePanel',()=>({default:({onShareAppleUsage}:{onShareAppleUsage?:(report:unknown)=>void})=><button onClick={()=>onShareAppleUsage?.({recordedAt:'2026-10-25T12:00:00Z',freshness:'fresh',inputTokens:11,outputTokens:9,cacheReadTokens:null,cacheWriteTokens:2,observedAt:'2026-10-25T12:01:00Z',receivedAt:1792929660000})}>Use latest report for Watch</button>}));
vi.mock('./VoicePanel',()=>({default:(props:{sessionId:string;onDirectDictation:(request:import('./voiceDelivery').DirectDictation)=>Promise<void>})=>{mocks.voiceProps(props);return <div>Voice for {props.sessionId}</div>;}}));
import App, { ConnectDialog, validateHost } from "./App";
import {applyAccessStatus, captureAccess} from './access';

const host: Host = {
  id: "home",
  name: "Home",
  hostname: "home.local",
  port: 22,
  username: "dev",
};

beforeEach(() => {
  generationBase+=10;
  vi.clearAllMocks();mocks.realAgents=false;mocks.accountUsageDisconnected=false;
  mocks.launchReceipt=null;mocks.hostLaunchReceipt=null;mocks.prepareError=null;
  vi.stubGlobal("localStorage", {
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    length: 0,
  });
  vi.stubGlobal("sessionStorage", {
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    length: 0,
  });
  mocks.createTerminal.mockImplementation(()=>{if(mocks.prepareError)throw mocks.prepareError;return mocks.terminal;});
  mocks.api.listHosts.mockResolvedValue([host]);
  mocks.invoke.mockResolvedValue(false);
  mocks.api.disconnect.mockResolvedValue(undefined);
  mocks.api.adoptSession.mockResolvedValue(undefined);
  mocks.api.trustHostKey.mockResolvedValue(undefined);
  mocks.api.ackOutput.mockResolvedValue(undefined);
  mocks.terminal.write.mockImplementation(
    (_data: Uint8Array, callback?: () => void) => callback?.(),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens AI account usage for the exact connected terminal from the existing footer',async()=>{
  mocks.api.connect.mockResolvedValue({sessionId:'usage-owner'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.accountUsageSession).toHaveBeenLastCalledWith('usage-owner');
  const bar=screen.getByRole('button',{name:'Open AI account usage'});
  expect(bar.closest('.workspace-footer')).not.toBeNull();await user.click(bar);
  expect(await screen.findByRole('region',{name:'AI account usage'})).toBeTruthy();
  expect(await screen.findByRole('button',{name:'Use latest report for Watch'})).toBeTruthy();
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.api.write).not.toHaveBeenCalled();
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
  await user.click(screen.getByRole('button',{name:'Usage'}));
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

it.each((Object.keys(transcriptAgents) as TranscriptAgentId[]).flatMap(agent=>(['plain','tmux'] as const).map(kind=>({agent,kind}))))('offers explicit $agent terminal input only on an actual $kind Chat session and targets the exact display',async({agent,kind})=>{
  const source=tmuxChatReaderSource(agent);
  mocks.api.connect.mockResolvedValue({sessionId:'plain-control'});mocks.api.attachTmux.mockResolvedValue({sessionId:'retained-display'});
  mocks.invoke.mockImplementation((command,args)=>{
    if(command==='multiplexer_tree')return Promise.resolve({tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,sessions:[{id:'$1',name:'work',windows:[]}]});
    if(command==='agent_transcript')return Promise.resolve(tmuxChatReaderPage(agent));
    if(command==='tmux_chat')return tmuxChatReply(command,args);
    return Promise.resolve(false);
  });
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  if(kind==='tmux'){
    await user.click(screen.getByRole('button',{name:'Sessions'}));await user.click(await screen.findByRole('button',{name:'Attach work'}));
    await waitFor(()=>expect(screen.getAllByRole('tab')).toHaveLength(2));
  }
  await user.click(screen.getByRole('button',{name:'Transcript'}));await user.selectOptions(await screen.findByLabelText('Agent'),agent);const path=screen.getByLabelText('Transcript path');await user.click(path);await user.paste(source.path);
  if('transcriptSessionId' in source)await user.type(screen.getByLabelText('Transcript session ID'),source.transcriptSessionId);
  await user.click(screen.getByRole('button',{name:'Open transcript'}));
  await screen.findByRole('button',{name:t('chatRefreshMessages')});
  expect(mocks.invoke).toHaveBeenCalledWith('agent_transcript',{sessionId:kind==='tmux'?'retained-display':'plain-control',agent,path:source.path,offset:0,...('transcriptSessionId' in source?{transcriptSessionId:source.transcriptSessionId}:{})},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  async function stage(text:string){
    const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
    try {await user.type(screen.getByLabelText('Draft for this terminal'),text);await user.click(screen.getByRole('button',{name:'Stage in terminal'}));}
    finally {window.removeEventListener('lazysh-prompt-draft',staged);}
    expect(staged).toHaveBeenCalledTimes(1);expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:kind==='tmux'?'retained-display':'plain-control',text});
  }
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='tmux_chat')).toHaveLength(0);
  if(kind==='plain'){expect(screen.queryByRole('button',{name:t('chatTerminalChoose')})).toBeNull();await stage('manual fallback');expect(mocks.invoke.mock.calls.filter(([command])=>command==='tmux_chat')).toHaveLength(0);return;}
  await user.click(screen.getByRole('button',{name:t('chatTerminalChoose')}));const input=screen.getByRole('region',{name:t('chatTerminalTitle')});
  await within(input).findByText('Agent work');expect(within(input).getByText('dev@home.local')).toBeTruthy();expect(within(input).getByText('Home / work')).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledWith('tmux_chat',{sessionId:'retained-display',action:{kind:'snapshot'}},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  await user.click(within(input).getByRole('button',{name:t('chatTerminalConfirm')}));await user.type(screen.getByLabelText('Draft for this terminal'),'explicit input');
  await user.click(within(input).getByRole('button',{name:t('chatTerminalSend')}));await within(input).findByText(t('chatTerminalSent'));
  expect(mocks.invoke).toHaveBeenCalledWith('tmux_chat',expect.objectContaining({sessionId:'retained-display',action:expect.objectContaining({kind:'input',source,operation:1,input:{kind:'send',text:'explicit input'}})}),{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  expect(mocks.api.write).not.toHaveBeenCalled();await stage('manual fallback');
});

const reportedAgent={sessionId:'opaque-claude-row',agent:'Claude Code',project:'/project',state:'working',updatedAt:'2026-10-24T19:30:00Z',summary:'Reported work',paneId:'%7',eventCount:1};
function reportedHistoryApp(response:unknown) {
  mocks.realAgents=true;
  mocks.invoke.mockImplementation(async(command,args)=>{
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:[reportedAgent]};
    if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
    if(command==='get_companion_settings')return {schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
    if(command==='board_keep_awake_status')return {available:false,active:false,reason:'Synthetic reported-history fixture',epoch:'1/11111111-1111-4111-8111-111111111111',ticket:0};
    if(command==='agent_reported_history')return typeof response==='function'?response(args):response;
    if(command==='agent_transcript')return {schemaVersion:1,agent:'claude',messages:[],nextOffset:0,hasMore:false};
    return false;
  });
}
const reportedAppMetadata={schemaVersion:1,status:'available',sessionId:reportedAgent.sessionId,path:'/project/Claude 世界.jsonl ',reportedAt:'2026-10-24T19:30:00Z',paneId:'%7'};
it('routes a selected actual Claude row to the exact SSH Chat prefill with read/image/follow defaults off and retires it on exit',async({signal,onTestFailed,onTestFinished})=>{
  type Stage='setup'|'render-app'|'open-host-dialog'|'type-password'|'connect-ssh'|'wait-live-ssh'
    |'open-agents'|'wait-history-action'|'use-history'|'wait-prefill'|'assert-defaults'|'open-transcript'
    |'wait-read-request'|'return-terminal'|'wait-terminal'|'return-transcript'|'wait-retired-path'|'assert-retired-notice';
  const started=performance.now();
  const cap=(value:number,maximum=60_000)=>Math.min(maximum,Math.max(0,Math.round(value)));
  const counts=()=>({
    connect:cap(mocks.api.connect.mock.calls.length,999),
    historyLookup:cap(mocks.invoke.mock.calls.filter(([command])=>command==='agent_reported_history').length,999),
    transcriptRead:cap(mocks.invoke.mock.calls.filter(([command])=>command==='agent_transcript').length,999),
  });
  const milestones:{stage:Stage;elapsedMs:number;lastObservedCounts:ReturnType<typeof counts>}[]=[];
  const mark=(stage:Stage)=>{
    if(!signal.aborted && milestones.length<18)milestones.push({stage,elapsedMs:cap(performance.now()-started),lastObservedCounts:counts()});
  };
  let atAbort:{elapsedMs:number;countsBeforeCleanup:ReturnType<typeof counts>}|undefined;
  const freezeOnAbort=()=>{atAbort={elapsedMs:cap(performance.now()-started),countsBeforeCleanup:counts()};};
  signal.addEventListener('abort',freezeOnAbort,{once:true});
  onTestFinished(()=>{signal.removeEventListener('abort',freezeOnAbort);});
  onTestFailed(()=>{
    try {
      console.error('Reported history routing failure progress',JSON.stringify({
        failureObservationElapsedMs:cap(performance.now()-started),atAbort,milestones,
      }));
    } catch { /* Diagnostics must preserve the original failure. */ }
  });
  mark('setup');
  reportedHistoryApp(reportedAppMetadata);mocks.api.connect.mockResolvedValue({sessionId:'ssh-reported-app'});
  const user=await openConnection(mark);
  mark('connect-ssh');await user.click(screen.getByRole('button',{name:'Connect'}));
  mark('wait-live-ssh');await screen.findByText('Live SSH terminal');
  mark('open-agents');await user.click(screen.getByRole('button',{name:'Agents'}));
  mark('wait-history-action');const historyAction=await screen.findByRole('button',{name:'Use reported history'});
  mark('use-history');await user.click(historyAction);
  mark('wait-prefill');const path=await screen.findByLabelText('Transcript path');
  mark('assert-defaults');expect(path).toHaveProperty('value',reportedAppMetadata.path);
  expect(screen.getByLabelText('Agent')).toHaveProperty('value','claude');expect(screen.getByLabelText('View')).toHaveProperty('value','records');
  expect(screen.getByLabelText('Include recorded images')).toHaveProperty('checked',false);expect(screen.queryByLabelText('Follow selected Claude branch')).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith('agent_reported_history',{sessionId:'ssh-reported-app',agentSessionId:reportedAgent.sessionId},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  expect(mocks.invoke.mock.calls.filter(([command])=>['agent_transcript','agent_transcripts'].includes(command))).toHaveLength(0);
  expect(mocks.api.write).not.toHaveBeenCalled();expect(screen.getByLabelText('Draft for this terminal')).toHaveProperty('value','');
  mark('open-transcript');await user.click(screen.getByRole('button',{name:'Open transcript'}));
  mark('wait-read-request');await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('agent_transcript',{sessionId:'ssh-reported-app',agent:'claude',path:reportedAppMetadata.path,offset:0},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}));
  mark('return-terminal');await user.click(screen.getByRole('button',{name:'Terminal'}));
  mark('wait-terminal');await screen.findByText('Live SSH terminal');
  mark('return-transcript');await user.click(screen.getByRole('button',{name:'Transcript'}));
  mark('wait-retired-path');expect(await screen.findByLabelText('Transcript path')).toHaveProperty('value','');
  mark('assert-retired-notice');expect(screen.queryByText(t('agentsHistoryNotice'))).toBeNull();
});
it.each(['success','failure'] as const)('prevents a pending actual Agent lookup %s from reopening Chat after hiding its navigation',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  reportedHistoryApp(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));mocks.api.connect.mockResolvedValue({sessionId:'ssh-reported-app'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Agents'}));await user.click(await screen.findByRole('button',{name:'Use reported history'}));
  await user.click(screen.getByRole('button',{name:'Connections'}));await screen.findByText('Live SSH terminal');
  await act(async()=>{if(outcome==='success')finish(reportedAppMetadata);else fail('old reported route error');});
  expect(screen.queryByLabelText('Transcript path')).toBeNull();expect(screen.queryByText('old reported route error')).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(1);
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

async function openConnection(onStep?:(stage:'render-app'|'open-host-dialog'|'type-password')=>void) {
  onStep?.('render-app');
  const user = userEvent.setup();
  render(<App />);
  onStep?.('open-host-dialog');
  await user.click(
    await screen.findByRole("button", { name: "Connect to Home" }),
  );
  onStep?.('type-password');
  await user.type(screen.getByLabelText("Password"), "temporary-secret");
  return user;
}

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

const hostLaunchReceipt='7b6d0fc9-a755-4e10-b2e3-0dbdc1259326';
function enableHostLaunch(selected:Host=host, jump?:Host, mux:unknown=null) {
  mocks.hostLaunchReceipt=hostLaunchReceipt;
  mocks.api.listHosts.mockResolvedValue([selected]);
  mocks.invoke.mockImplementation(async(command:string)=>{
    if(command==='local_capability')return {available:true,reason:'Desktop fixture'};
    if(command==='desktop_launch_prepare_host')return {hosts:jump?[selected,jump]:[selected],mux};
    if(command==='desktop_launch_cancel')return;
    if(command==='transport_capabilities')return {mosh:true,et:true};
    return false;
  });
}
function enableMuxLaunch(mux:DesktopMux,transport:TransportMode='ssh') {
  enableHostLaunch({...host,transport},undefined,mux);
  const invoke=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async(command,...args)=>command==='multiplexer_tree'?{tmuxAvailable:true,herdrAvailable:true,zellijAvailable:true,sessions:[{id:'$1',name:'chosen',windows:[]}]}:command==='multiplexer_sessions'?[{name:'herd'}]:invoke(command,...args));
  mocks.api.connect.mockResolvedValue({sessionId:'mux-control'});
  mocks.api.attachTmux.mockResolvedValue({sessionId:'mux-attached'});mocks.api.attachMultiplexer.mockResolvedValue({sessionId:'mux-attached'});
}
it('opens the exact saved host through its normal dialog and binds the native receipt to explicit authentication',async()=>{
  enableHostLaunch({...host,id:'legacy=host 世界'});
  mocks.api.connect.mockResolvedValue({sessionId:'host-launch-ssh'});
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('dialog',{name:'Connect to Home'});
  expect(mocks.api.connect).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Password'),'entered-only-here');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.connect).toHaveBeenCalledWith('legacy=host 世界',{password:'entered-only-here'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
});
it('defers a warm saved-host launch without replacing a manual password dialog',async()=>{
  const warm={...host,id:'warm',name:'Warm destination'};
  enableHostLaunch(warm);mocks.hostLaunchReceipt=null;mocks.api.listHosts.mockResolvedValue([host,warm]);
  const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Connect to Home'}));
  await user.type(await screen.findByLabelText('Password'),'manual-value');
  await act(async()=>{mocks.hostLaunchReceipt=hostLaunchReceipt;mocks.launchEvent?.({payload:null});});
  expect(screen.getByRole('dialog',{name:'Connect to Home'})).toBeTruthy();
  expect(screen.getByLabelText('Password')).toHaveProperty('value','manual-value');
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(0);
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  await screen.findByRole('dialog',{name:'Connect to Warm destination'});
  expect(screen.getByLabelText('Password')).toHaveProperty('value','');
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(1);
  expect(mocks.api.connect).not.toHaveBeenCalled();
});

it.each([
  ['HOST_LAUNCH_MISSING','This saved host no longer exists. Copy an existing host ID and run the command again.'],
  ['HOST_LAUNCH_AMBIGUOUS','More than one saved host has this ID. Resolve the duplicate before trying again.'],
])('reports native host preparation failure without opening a connection: %s',async(code,message)=>{
  enableHostLaunch();
  const prepare=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,...args)=>command==='desktop_launch_prepare_host'?Promise.reject(code):prepare(command,...args));
  render(<App/>);expect((await screen.findByRole('alert')).textContent).toContain(message);
  expect(screen.queryByRole('dialog')).toBeNull();expect(mocks.api.connect).not.toHaveBeenCalled();
});

it.each(['preparation','native'] as const)('brands a finite saved-host failure only at its native await, preserving raw %s errors',async origin=>{
  enableHostLaunch();
  if(origin==='preparation')mocks.prepareError='HOST_LAUNCH_CHANGED';
  else mocks.api.connect.mockRejectedValue({kind:'HOST_LAUNCH_CHANGED',message:'HOST_LAUNCH_CHANGED'});
  const user=userEvent.setup();render(<App/>);await screen.findByLabelText('Password');
  await user.type(screen.getByLabelText('Password'),'entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  try {
    for(const locale of ['en','pt-BR','es']) {
      await act(async()=>{await uiI18n.changeLanguage(locale);});
      const expected=origin==='preparation'?'HOST_LAUNCH_CHANGED':t('desktopLaunchHostChanged');
      expect((await screen.findByRole('alert')).textContent).toBe(expected);
    }
  } finally {await act(async()=>{await uiI18n.changeLanguage('en');});}
  if(origin==='preparation')expect(mocks.api.connect).not.toHaveBeenCalled();
});

it.each([
  ['mosh',{kind:'tmux',tmuxServer:'default'}],
  ['et',{kind:'tmux',tmuxServer:"世界 '$(touch NO);"}],
  ['auto',{kind:'herdr'}],
] as const)('opens a cold mux picker on its exact SSH source without applying saved %s transport',async(transport,mux)=>{
  enableMuxLaunch(mux,transport);
  const user=userEvent.setup();render(<App/>);const selector=await screen.findByLabelText('Transport');
  expect(selector).toHaveProperty('value','ssh');expect(selector).toHaveProperty('disabled',true);
  await user.type(screen.getByLabelText('Password'),'explicit-entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  const label=mux.kind==='herdr'?'Attach herdr herd':'Attach chosen';
  const row=await screen.findByRole('button',{name:label});
  expect(mocks.api.connect).toHaveBeenCalledExactlyOnceWith('home',{password:'explicit-entry'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
  expect(mocks.api.attachTmux).not.toHaveBeenCalled();expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();expect(mocks.api.connectEt).not.toHaveBeenCalled();
  await user.click(row);await waitFor(()=>expect(screen.getAllByRole('tab')).toHaveLength(2));
  if(mux.kind==='herdr')expect(mocks.api.attachMultiplexer).toHaveBeenCalledWith('mux-control','herdr','herd',expect.any(Function));
  else expect(mocks.api.attachTmux).toHaveBeenCalledWith('mux-control','chosen',expect.any(Function),mux.tmuxServer==='default'?undefined:mux.tmuxServer);
  expect(mocks.api.write).not.toHaveBeenCalled();expect(mocks.api.saveHost).not.toHaveBeenCalled();
});

it('binds a newly offered mux picker to its new SSH control rather than the already active session',async()=>{
  enableMuxLaunch({kind:'tmux',tmuxServer:'agents'});mocks.hostLaunchReceipt=null;
  mocks.api.connect.mockResolvedValueOnce({sessionId:'old-active'}).mockResolvedValueOnce({sessionId:'new-exact-source'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  mocks.hostLaunchReceipt=hostLaunchReceipt;await act(async()=>{mocks.launchEvent!({payload:null});});
  await screen.findByLabelText('Password');await user.type(screen.getByLabelText('Password'),'second-entry');
  await user.click(screen.getByRole('button',{name:'Connect'}));const row=await screen.findByRole('button',{name:'Attach chosen'});
  expect(mocks.invoke).toHaveBeenCalledWith('multiplexer_tree',{sessionId:'new-exact-source',tmuxServer:'agents'},expect.anything());
  await user.click(screen.getByRole('button',{name:'Terminal'}));await screen.findByText('Live SSH terminal');
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.api.attachTmux).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Sessions'}));await screen.findByRole('button',{name:'Attach chosen'});
  expect(screen.getByLabelText('tmux server')).toHaveProperty('value','agents');
  await user.click(screen.getByRole('button',{name:'Attach chosen'}));
  await waitFor(()=>expect(mocks.api.attachTmux).toHaveBeenCalledWith('new-exact-source','chosen',expect.any(Function),'agents'));
  expect(mocks.api.write).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenLastCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home'},{hostId:'home'},{hostId:'home',attached:{kind:'tmux',name:'chosen',tmuxServer:'agents'}}]));
});
it.each(['success','failure'] as const)('drops a held cold-mux SSH %s across lock/reunlock without starting a picker or child',async outcome=>{
  enableMuxLaunch({kind:'herdr'});
  let finish!:(value:{sessionId:string})=>void,fail!:(reason:unknown)=>void;
  mocks.api.connect.mockImplementationOnce(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));
  const user=userEvent.setup();render(<App/>);await screen.findByLabelText('Password');await user.type(screen.getByLabelText('Password'),'entry');
  await user.click(screen.getByRole('button',{name:'Connect'}));await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledTimes(1));
  await act(async()=>{
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined}});
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,generation:String(generationBase+2),nonce:'b'.repeat(64)}});
    if(outcome==='success')finish({sessionId:'obsolete-mux-control'});else fail({kind:'unknown_host_key',fingerprint:'SHA256:obsolete',message:'Old key'});
  });
  await screen.findByRole('button',{name:'Connect to Home'});
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='multiplexer_tree'||command==='multiplexer_sessions')).toHaveLength(0);
  expect(mocks.api.attachTmux).not.toHaveBeenCalled();expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
  if(outcome==='success')await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'obsolete-mux-control'}));
});

it.each([null,{kind:'tmux',tmuxServer:'trusted-server'}] as const)('reuses the original saved-host receipt only after an explicit host-key trust retry with mux %j',async mux=>{
  if(mux)enableMuxLaunch(mux);else enableHostLaunch();
  mocks.api.connect.mockRejectedValueOnce({kind:'unknown_host_key',fingerprint:'SHA256:launch',message:'Verify key'}).mockResolvedValue({sessionId:'host-trusted'});
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('dialog',{name:'Connect to Home'});
  await user.type(screen.getByLabelText('Password'),'entered-credential');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('SHA256:launch');
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  if(mux)expect(mocks.invoke.mock.calls.filter(([command])=>command==='multiplexer_tree'||command==='multiplexer_sessions')).toHaveLength(0);
  expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Trust key and connect'}));
  if(mux)await screen.findByRole('button',{name:'Attach chosen'});else await screen.findByText('Live SSH terminal');
  expect(mocks.api.trustHostKey).toHaveBeenCalledWith(host.id,'SHA256:launch',hostLaunchReceipt);
  if(mux)expect(mocks.invoke).toHaveBeenCalledWith('multiplexer_tree',{sessionId:'host-trusted',tmuxServer:'trusted-server'},expect.anything());
  expect(mocks.api.connect).toHaveBeenCalledTimes(2);
  for(const call of mocks.api.connect.mock.calls)expect(call[3]).toEqual({launchReceipt:hostLaunchReceipt});
});
it('retires a saved-host request only on explicit cancellation, not mount setup',async()=>{
  enableHostLaunch();const user=userEvent.setup();render(<App/>);
  await screen.findByRole('dialog',{name:'Connect to Home'});
  expect(mocks.invoke.mock.calls.some(([name])=>name==='desktop_launch_cancel')).toBe(false);
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.invoke).toHaveBeenCalledWith('desktop_launch_cancel',{receipt:hostLaunchReceipt},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  expect(mocks.api.connect).not.toHaveBeenCalled();
});
it.each(['mosh','et','auto','ssh'] as const)('retains the saved %s transport and the receipt on initial native authentication',async transport=>{
  enableHostLaunch({...host,transport});
  mocks.api.connect.mockResolvedValue({sessionId:'bound-ssh-control'});
  mocks.api.connectMosh.mockResolvedValue({sessionId:'bound-mosh'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'bound-et'});
  const user=userEvent.setup();render(<App/>);
  const selector=await screen.findByLabelText('Transport');
  await waitFor(()=>expect((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled).toBe(false));
  expect((selector as HTMLSelectElement).value).toBe(transport);
  await user.type(screen.getByLabelText('Password'),'entered');await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.connect).toHaveBeenCalledWith(host.id,{password:'entered'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
  expect(mocks.api.connectMosh).toHaveBeenCalledTimes(transport==='mosh'||transport==='auto'?1:0);
  expect(mocks.api.connectEt).toHaveBeenCalledTimes(transport==='et'?1:0);
});
it.each(['remember','saved','jump'] as const)('keeps the launch receipt in the %s credential option branch',async branch=>{
  const selected=branch==='jump'?{...host,jumpHostId:'bastion'}:host;
  enableHostLaunch(selected,branch==='jump'?{...host,id:'bastion',name:'Bastion',hostname:'jump.local'}:undefined);
  if(branch==='saved')mocks.invoke.mockImplementation(async command=>command==='local_capability'?{available:true,reason:''}:command==='desktop_launch_prepare_host'?{hosts:[host]}:command==='has_credentials'?true:{mosh:true,et:true});
  mocks.api.connect.mockResolvedValue({sessionId:'branch-session'});
  const user=userEvent.setup();render(<App/>);await screen.findByRole('dialog',{name:'Connect to Home'});
  if(branch==='remember')await user.click(screen.getByLabelText('Save credentials on this device after connecting'));
  else if(branch==='saved')expect(await screen.findByLabelText('Use saved credentials')).toHaveProperty('checked',true);
  else {await user.click(screen.getByLabelText('Use bastion’s saved credentials'));await user.type(screen.getByLabelText('Bastion password'),'jump-entry');}
  if(branch!=='saved')await user.type(screen.getByLabelText('Password'),'target-entry');
  await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  const options=mocks.api.connect.mock.calls[0][3];expect(options.launchReceipt).toBe(hostLaunchReceipt);
  expect(options).toMatchObject(branch==='remember'?{rememberCredentials:true}:branch==='saved'?{useSavedCredentials:true}:{jumpCredentials:{password:'jump-entry'}});
});
function holdSshAcrossRevocation() {
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.connect.mockImplementation((_id,_credentials,onEvent)=>{
    onEvent({type:'data',data:[120]});
    return new Promise(resolve=>{finish=resolve;});
  });
  mocks.api.connectMosh.mockResolvedValue({sessionId:'forbidden-mosh-child'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'forbidden-et-child'});
  mocks.api.ackOutput.mockImplementationOnce(async()=>{
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined}});
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}});
  });
  return async()=>{
    await act(async()=>{finish({sessionId:'held-original-ssh'});});
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'held-original-ssh'}));
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.api.connectMosh).not.toHaveBeenCalled();expect(mocks.api.connectEt).not.toHaveBeenCalled();
    expect(mocks.api.adoptSession).not.toHaveBeenCalled();
  };
}
it.each(['mosh','et'] as const)('does not renew a held saved-host SSH result before %s child work after revoke/reunlock',async transport=>{
  enableHostLaunch({...host,transport});
  const complete=holdSshAcrossRevocation();
  const user=userEvent.setup();render(<App/>);await screen.findByLabelText('Password');
  await user.type(screen.getByLabelText('Password'),'entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledTimes(1));
  await complete();
});
it('keeps workspace restoration receipt-free and stops transport child work under its original lease',async()=>{
  enableTransports();
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',auto:autoOptions}]):null);
  const complete=holdSshAcrossRevocation();
  const user=userEvent.setup();render(<App/>);await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledWith('home',{},expect.any(Function),{useSavedCredentials:true}));
  await complete();
});

it.each([
  {kind:'unknown_host_key',fingerprint:'SHA256:obsolete-launch-key',message:'Obsolete key prompt'},
  {kind:'auth',message:'Obsolete credential failure'},
])('does not publish a stale $kind result into the same mounted launch dialog',async failure=>{
  applyAccessStatus(unlockedStatus());
  const launch={receipt:hostLaunchReceipt,lease:captureAccess(),hosts:[host],mux:null};
  let reject!:(error:unknown)=>void;
  mocks.api.connect.mockImplementation(()=>new Promise((_yes,no)=>{reject=no;}));
  const connected=vi.fn(),close=vi.fn();
  const user=userEvent.setup();render(<ConnectDialog host={host} hosts={[host]} launch={launch} connected={connected} close={close}/>);
  await user.type(screen.getByLabelText('Password'),'original-entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledTimes(1));
  await act(async()=>{
    applyAccessStatus({...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined});
    applyAccessStatus({...unlockedStatus(),enabled:true,generation:String(generationBase+2),nonce:'b'.repeat(64)});
    reject(failure);
  });
  await waitFor(()=>expect(mocks.terminal.dispose).toHaveBeenCalled());
  expect(screen.getByRole('dialog',{name:'Connect to Home'})).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText('SHA256:obsolete-launch-key')).toBeNull();
  expect((screen.getByRole('button',{name:t('appConnecting')}) as HTMLButtonElement).disabled).toBe(true);
  expect(connected).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
  expect(mocks.api.trustHostKey).not.toHaveBeenCalled();expect(mocks.api.connect).toHaveBeenCalledTimes(1);
});

it('copies only the saved host ID on an explicit edit-dialog action and translates its status',async()=>{
  const user=userEvent.setup();
  const write=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{value:{writeText:write},configurable:true});
  render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  expect((screen.getByLabelText('Host ID') as HTMLInputElement).value).toBe(host.id);
  expect(write).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Copy host ID'}));
  await screen.findByText('Host ID copied.');expect(write).toHaveBeenCalledExactlyOnceWith(host.id);
  try {await act(async()=>{await uiI18n.changeLanguage('pt-BR');});expect(screen.getByRole('status').textContent).toBe('ID do host copiado.');}
  finally {await act(async()=>{await uiI18n.changeLanguage('en');});}
});

it('keeps the existing terminal session while clearing tool views across native lock', async () => {
  mocks.api.connect.mockResolvedValue({sessionId:'retained-ssh'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Transcript'}));
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  expect(screen.queryByText('Live SSH terminal')).toBeNull();expect(screen.queryByRole('tab')).toBeNull();
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}}));
  await screen.findByText('Live SSH terminal');
  expect(screen.getAllByRole('tab')).toHaveLength(1);expect(mocks.api.connect).toHaveBeenCalledOnce();
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.terminal.dispose).not.toHaveBeenCalled();
});

it('does not register a late pre-lock connection into the retained session registry', async () => {
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.connect.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}}));
  await act(async()=>finish({sessionId:'stale-ssh'}));
  await screen.findByRole('button',{name:'Connect to Home'});
  expect(screen.queryByRole('tab')).toBeNull();expect(screen.queryByText('Live SSH terminal')).toBeNull();
});

it('tears down known pending bootstrap IDs on lock while retaining an adopted terminal and suppressing disposed replay',async()=>{
  enableTransports();
  mocks.api.connect.mockResolvedValueOnce({sessionId:'adopted-live-lock-test'}).mockResolvedValueOnce({sessionId:'pending-bootstrap-lock-test'});
  let finish!:(value:{sessionId:string})=>void;let replay!:(event:unknown)=>void;
  mocks.api.connectMosh.mockImplementation((_parent,_options,onEvent)=>{replay=onEvent;return new Promise(resolve=>{finish=resolve;});});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');await waitFor(()=>expect(mocks.api.adoptSession).toHaveBeenCalledWith('adopted-live-lock-test'));
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));
  await user.type(screen.getByLabelText('Password'),'second-secret');await user.selectOptions(screen.getByLabelText('Transport'),'auto');
  await user.click(screen.getByRole('button',{name:'Connect'}));await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'pending-bootstrap-lock-test'});
  expect(mocks.invoke).not.toHaveBeenCalledWith('disconnect',{sessionId:'adopted-live-lock-test'});
  await act(async()=>finish({sessionId:'late-pending-lock-test'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'late-pending-lock-test'}));
  mocks.terminal.write.mockClear();replay({type:'data',data:[115,101,99,114,101,116]});expect(mocks.terminal.write).not.toHaveBeenCalled();
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}}));
  await screen.findByText('Live SSH terminal');expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(mocks.api.adoptSession).toHaveBeenCalledTimes(1);
});

it('closes known pending restoration IDs when lock revokes the old mount',async()=>{
  enableTransports();
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',mosh:{serverPath:'mosh-server',portMin:60000,portMax:61000}}]):null);
  mocks.api.connect.mockResolvedValue({sessionId:'restoration-pending-lock-test'});
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.connectMosh.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=userEvent.setup();render(<App/>);await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'restoration-pending-lock-test'});
  await act(async()=>finish({sessionId:'restoration-late-lock-test'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'restoration-late-lock-test'}));
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();
});

describe("host validation", () => {
  it("accepts direct IPv4, IPv6, and tailnet destinations and rejects ambiguous SSH strings", () => {
    for (const hostname of [
      "100.70.0.2",
      "2001:db8::1",
      "machine.tailnet.ts.net",
    ])
      expect(validateHost({ ...host, hostname })).toBe("");
    for (const hostname of [
      "dev@host",
      "host/path",
      "host name",
      "host\noption",
    ])
      expect(validateHost({ ...host, hostname })).not.toBe("");
    for (const port of [0, 65536, 22.5, NaN])
      expect(validateHost({ ...host, port })).not.toBe("");
  });
});

describe("connection flow", () => {
  it("trusts the bastion identity separately and never substitutes the destination password", async () => {
    const jump = {
      ...host,
      id: "jump",
      name: "Gateway",
      hostname: "gateway.local",
    };
    mocks.api.listHosts.mockResolvedValue([
      { ...host, jumpHostId: "jump" },
      jump,
    ]);
    mocks.api.connect
      .mockRejectedValueOnce({
        kind: "unknown_host_key",
        hostId: "jump",
        fingerprint: "SHA256:jump",
        message: "Verify gateway",
      })
      .mockResolvedValueOnce({ sessionId: "routed" });
    const user = await openConnection();
    await user.click(screen.getByLabelText("Use bastion’s saved credentials"));
    await user.type(
      screen.getByLabelText("Bastion password"),
      "gateway-secret",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("gateway.local:22")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Trust key and connect" }),
    );
    expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
    expect(mocks.api.trustHostKey).toHaveBeenCalledWith("jump", "SHA256:jump");
    expect(mocks.api.connect).toHaveBeenLastCalledWith(
      "home",
      { password: "temporary-secret" },
      expect.any(Function),
      {
        rememberCredentials: false,
        useSavedCredentials: false,
        jumpCredentials: { password: "gateway-secret" },
      },
    );
  });

  it("defaults to available saved native credentials without exposing their values", async () => {
    mocks.invoke.mockImplementation(
      async (command) => command === "has_credentials",
    );
    mocks.api.connect.mockResolvedValue({ sessionId: "saved" });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Connect to Home" }),
    );
    expect(await screen.findByLabelText("Use saved credentials")).toHaveProperty('checked',true);
    expect(screen.queryByLabelText("Password")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
    expect(mocks.api.connect).toHaveBeenCalledWith(
      "home",
      {},
      expect.any(Function),
      { rememberCredentials: false, useSavedCredentials: true },
    );
    expect(window.localStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      "lazysh.workspace.v1",
      '[{"hostId":"home"}]',
    );
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('preserves manually entered credentials when the saved-credential check finishes late',async()=>{
    const original=mocks.invoke.getMockImplementation()!;
    let finish!:(saved:boolean)=>void;
    mocks.invoke.mockImplementation((command,...args)=>command==='has_credentials'?new Promise<boolean>(resolve=>{finish=resolve;}):original(command,...args));
    mocks.api.connect.mockResolvedValue({sessionId:'manual-choice'});
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole('button',{name:'Connect to Home'}));
    await user.type(await screen.findByLabelText('Password'),'manual-entry');
    await act(async()=>finish(true));
    expect(await screen.findByLabelText('Use saved credentials')).toHaveProperty('checked',false);
    expect(screen.getByLabelText('Password')).toHaveProperty('value','manual-entry');
    await user.click(screen.getByRole('button',{name:'Connect'}));
    await screen.findByText('Live SSH terminal');
    expect(mocks.api.connect).toHaveBeenCalledExactlyOnceWith('home',{password:'manual-entry'},expect.any(Function));
  });

  it.each(['Password','Private key'])('allows an explicit %s choice after saved credentials become the default',async method=>{
    mocks.invoke.mockImplementation(async command=>command==='has_credentials');
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole('button',{name:'Connect to Home'}));
    const saved=await screen.findByLabelText('Use saved credentials');
    expect(saved).toHaveProperty('checked',true);
    await user.click(screen.getByRole('button',{name:method}));
    expect(saved).toHaveProperty('checked',false);
    expect(screen.getByLabelText(method==='Password'?'Password':'Private key (OpenSSH or PEM)')).toBeTruthy();
  });

  it("forgets saved credentials before removing the saved-login option", async () => {
    mocks.invoke.mockImplementation(
      async (command) => command === "has_credentials",
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Connect to Home" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Forget saved credentials" }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Use saved credentials")).toBeNull(),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("forget_credentials", {
      hostId: "home",
    }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  });

  it("requires explicit host-key acceptance before retrying and keeps credentials out of storage", async () => {
    mocks.api.connect
      .mockRejectedValueOnce({
        kind: "unknown_host_key",
        message: "Verify key",
        fingerprint: "SHA256:known-key",
      })
      .mockResolvedValueOnce({ sessionId: "one" });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("SHA256:known-key")).toBeTruthy();
    expect(mocks.api.connect).toHaveBeenCalledTimes(1);
    expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Trust key and connect" }),
    );
    expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
    expect(mocks.api.trustHostKey).toHaveBeenCalledWith(
      "home",
      "SHA256:known-key",
    );
    expect(mocks.api.connect).toHaveBeenLastCalledWith(
      "home",
      { password: "temporary-secret" },
      expect.any(Function),
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(window.localStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      "lazysh.workspace.v1",
      '[{"hostId":"home"}]',
    );
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("blocks a changed key without offering a trust shortcut", async () => {
    mocks.api.connect.mockRejectedValue({
      kind: "host_key_changed",
      message: "Changed",
      fingerprint: "SHA256:attacker",
    });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Connection blocked",
    );
    expect(
      screen.queryByRole("button", { name: "Trust key and connect" }),
    ).toBeNull();
    expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
  });

  it("does not create duplicate sessions while authentication is pending", async () => {
    let resolve: (value: { sessionId: string }) => void = () => {};
    mocks.api.connect.mockImplementation(
      () =>
        new Promise((value) => {
          resolve = value;
        }),
    );
    const user = await openConnection();
    await user.dblClick(screen.getByRole("button", { name: "Connect" }));
    expect(mocks.api.connect).toHaveBeenCalledTimes(1);
    resolve({ sessionId: "one" });
    await screen.findByText("Live SSH terminal");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("forwards split multibyte output intact and acknowledges consumed bytes after the session is established", async () => {
    mocks.api.connect.mockImplementation(
      async (
        _host: string,
        _credentials: unknown,
        onEvent: (event: unknown) => void,
      ) => {
        const bytes = new TextEncoder().encode("你好");
        onEvent({ type: "data", data: Array.from(bytes.slice(0, 2)) });
        onEvent({ type: "data", data: Array.from(bytes.slice(2)) });
        expect(mocks.api.ackOutput).not.toHaveBeenCalled();
        return { sessionId: "one" };
      },
    );
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    const forwarded = new Uint8Array(
      mocks.terminal.write.mock.calls.flatMap((call) =>
        Array.from(call[0] as Uint8Array),
      ),
    );
    expect(new TextDecoder().decode(forwarded)).toBe("你好");
    expect(mocks.api.ackOutput).toHaveBeenCalledWith("one", 6);
  });

  it("attaches tmux in a separate terminal without injecting input or replacing the original tab", async () => {
    mocks.api.connect.mockResolvedValue({ sessionId: "one" });
    mocks.invoke.mockResolvedValue({
      tmuxAvailable: true,
      herdrAvailable: false,
      zellijAvailable: false,
      sessions: [{ id: "$1", name: "work", windows: [] }],
    });
    mocks.api.attachTmux.mockResolvedValue({ sessionId: "two" });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    await user.click(
      await screen.findByRole("button", { name: "Attach work" }),
    );
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(mocks.api.attachTmux).toHaveBeenCalledWith(
      "one",
      "work",
      expect.any(Function),
      undefined,
    );
    expect(mocks.api.write).not.toHaveBeenCalled();
    expect(mocks.api.disconnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /^Home$/ }));
    expect(screen.getByText("Live SSH terminal")).toBeTruthy();
  });

  it.each([['exact\u00a0native name', undefined], ['exact\u00a0native name', "世界 '$(touch NO);"], [null, undefined]])('jumps inside the display and preserves restoration identity %s on server %s', async (restoreName, tmuxServer) => {
    mocks.api.connect.mockResolvedValue({sessionId:'source'});
    mocks.invoke.mockResolvedValue({tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,sessions:[{id:'$1',name:'work',windows:[]}]});
    mocks.api.attachTmux.mockResolvedValue({sessionId:'display'});
    const snapshot={generation:'native-only-generation',current:{sessionId:'$1',windowId:'@1'},sessions:[
      {id:'$1',name:'work',restoreName:'work',windows:[{id:'@1',index:0,name:'agent'}]},
      {id:'$2',name:'destination',restoreName,windows:[{id:'@2',index:1,name:'build'}]},
    ]};
    mocks.api.tmuxJumpSnapshot.mockResolvedValue(snapshot);
    mocks.api.tmuxJump.mockResolvedValue({...snapshot,current:{sessionId:'$2',windowId:'@2'}});
    const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
    await screen.findByText('Live SSH terminal');expect(screen.queryByRole('button',{name:'Jump To'})).toBeNull();
    await user.click(screen.getByRole('button',{name:'Sessions'}));
    if(tmuxServer){await user.clear(screen.getByLabelText('tmux server'));await user.type(screen.getByLabelText('tmux server'),tmuxServer);await user.click(screen.getByRole('button',{name:'Browse server'}));}
    await user.click(await screen.findByRole('button',{name:'Attach work'}));
    expect(mocks.api.attachTmux).toHaveBeenCalledWith('source','work',expect.any(Function),tmuxServer);
    await user.click(await screen.findByRole('button',{name:'Jump To'}));
    await user.click(await screen.findByRole('button',{name:'1: build'}).catch(error=>{
      // Failure evidence for #109; preserve the original query deadline and error.
      try {
        const dialog=document.querySelector('[role="dialog"][aria-label="Jump To"]');
        const panel=dialog?.querySelector('[aria-label="tmux Jump To"]');
        console.error('Jump To target query diagnostics', {
          dialogPresent:!!dialog,panelPresent:!!panel,
          dialogText:dialog?.textContent?.slice(0,800),
          layout:panel?.querySelector('select')?.value,
          visibleTargets:screen.queryAllByRole('button',{name:'1: build'}).length,
          includingHiddenTargets:screen.queryAllByRole('button',{name:'1: build',hidden:true}).length,
          snapshotCalls:mocks.api.tmuxJumpSnapshot.mock.calls.length,
          lastSnapshotSession:String(mocks.api.tmuxJumpSnapshot.mock.lastCall?.[0]??'').slice(0,120),
          activeTab:document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.slice(0,120),
        });
      } catch { /* Diagnostics must never replace the original test failure. */ }
      throw error;
    }));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Jump To'})).toBeNull());
    expect(mocks.api.tmuxJump).toHaveBeenCalledWith('display','native-only-generation','$2','@2');
    expect(screen.getByRole('tab',{name:'Home / destination'})).toBeTruthy();
    expect(localStorage.setItem).toHaveBeenLastCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home'},...(restoreName === null ? [] : [{hostId:'home',attached:{kind:'tmux',name:restoreName,...(tmuxServer===undefined?{}:{tmuxServer})}}])]));
    if (restoreName === null) expect(screen.getByText(/This tmux destination cannot be restored/)).toBeTruthy();
    else expect(screen.queryByText(/This tmux destination cannot be restored/)).toBeNull();
    mocks.api.tmuxJumpSnapshot.mockResolvedValue({...snapshot,current:{sessionId:'$2',windowId:'@2'}});
    await user.click(screen.getByRole('button',{name:'Jump To'}));
    expect(await screen.findByRole('button',{name:'1: build · Current'})).toBeTruthy();
    expect(mocks.api.write).not.toHaveBeenCalled();expect(mocks.api.disconnect).not.toHaveBeenCalled();
  });

  it("only returns output credit after the terminal has consumed a chunk", async () => {
    let consumed: (() => void) | undefined;
    mocks.terminal.write.mockImplementation(
      (_data: Uint8Array, callback?: () => void) => {
        consumed = callback;
      },
    );
    mocks.api.connect.mockImplementation(
      async (
        _host: string,
        _credentials: unknown,
        onEvent: (event: unknown) => void,
      ) => {
        onEvent({ type: "data", data: [97, 98, 99] });
        return { sessionId: "one" };
      },
    );
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    expect(mocks.api.ackOutput).not.toHaveBeenCalled();
    consumed?.();
    expect(mocks.api.ackOutput).toHaveBeenCalledWith("one", 3);
  });
});

it("saves only host metadata through the native API", async () => {
  mocks.api.listHosts.mockResolvedValue([]);
  mocks.api.saveHost.mockResolvedValue(host);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Add your first host" }));
  await user.type(screen.getByLabelText("Name"), "Home");
  await user.type(screen.getByLabelText("Hostname or IP"), "home.local");
  await user.type(screen.getByLabelText("Username"), "dev");
  await user.click(screen.getByRole("button", { name: "Save host" }));
  await waitFor(() =>
    expect(mocks.api.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Home",
        hostname: "home.local",
        username: "dev",
        port: 22,
      }),
    ),
  );
  expect(Object.keys(mocks.api.saveHost.mock.calls[0][0]).sort()).toEqual([
    "hostname",
    "id",
    "name",
    "port",
    "transport",
    "username",
  ]);
});

it("focuses host search when opened with the command palette shortcut", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Connect to Home" });
  await user.keyboard("{Control>}k{/Control}");
  const search = await screen.findByRole("textbox", {
    name: "Search saved hosts",
  });
  expect(document.activeElement).toBe(search);
  await user.keyboard("missing-host");
  expect(
    await screen.findByText(
      "No matching hosts. Add one to start a connection.",
    ),
  ).toBeTruthy();
});

it.each([undefined, "agents"])("restores the exact tmux workspace on server %s without sending shell text", async tmuxServer => {
  vi.mocked(localStorage.getItem).mockReturnValue(
    JSON.stringify([
      { hostId: "home", attached: { kind: "tmux", name: "durable-agent", ...(tmuxServer===undefined?{}:{tmuxServer}) } },
    ]),
  );
  mocks.api.connect.mockResolvedValue({ sessionId: "temporary-shell" });
  mocks.api.attachTmux.mockResolvedValue({ sessionId: "restored-agent" });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Connect to Home" });
  await user.click(
    screen.getByRole("button", { name: "Restore previous workspace" }),
  );
  expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledWith(
    "home",
    {},
    expect.any(Function),
    { useSavedCredentials: true },
  );
  expect(mocks.api.attachTmux).toHaveBeenCalledWith(
    "temporary-shell",
    "durable-agent",
    expect.any(Function),
    tmuxServer,
  );
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"temporary-shell"});
  expect(mocks.api.write).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenLastCalledWith(
    "lazysh.workspace.v1",
    JSON.stringify([
      { hostId: "home", attached: { kind: "tmux", name: "durable-agent", ...(tmuxServer===undefined?{}:{tmuxServer}) } },
    ]),
  );
});

it("exports a protected key only on explicit request and clears it when forgotten", async () => {
  mocks.api.listHosts.mockResolvedValue([
    { ...host, biometricUnlock: true, credentialsStored: true },
  ]);
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "has_credentials"
      ? true
      : command === "export_saved_identity"
        ? { privateKey: "test-private-key" }
        : undefined,
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect to Home" }),
  );
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    "export_saved_identity",
    expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } }
  );
  await user.click(
    screen.getByRole("button", { name: "Export private key with biometrics" }),
  );
  expect(
    (
      (await screen.findByLabelText(
        "Exported private key",
      )) as HTMLTextAreaElement
    ).value,
  ).toBe("test-private-key");
  await user.click(
    screen.getByRole("button", { name: "Forget saved credentials" }),
  );
  await waitFor(() =>
    expect(screen.queryByLabelText("Exported private key")).toBeNull(),
  );
  expect(localStorage.setItem).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.stringContaining("test-private-key"),
  );
});

async function openPendingKeyExport(exporter: () => Promise<unknown>) {
  mocks.api.listHosts.mockResolvedValue([{ ...host, biometricUnlock: true, credentialsStored: true }]);
  mocks.invoke.mockImplementation((command: string) => command === "export_saved_identity" ? exporter() : Promise.resolve(command === "has_credentials"));
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Connect to Home" }));
  await user.click(screen.getByRole("button", { name: "Export private key with biometrics" }));
  return user;
}
function verifiedMoshControl() {
  mocks.invoke.mockImplementation(async (command: string) => command === "transport_capabilities" ? { mosh: true } : false);
  mocks.api.connect.mockResolvedValue({ sessionId: "ssh-control" });
}

it("allows cancellation while private key authentication is pending", async () => {
  const user = await openPendingKeyExport(() => new Promise(() => {}));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_credential_auth", undefined, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(
    screen.queryByRole("button", {
      name: "Export private key with biometrics",
    }),
  ).toBeNull();
});

it("clears exported keys on background and rejects a late authentication result", async () => {
  let resolveExport: ((value: { privateKey: string }) => void) | undefined;
  const user = await openPendingKeyExport(() => new Promise(resolve => { resolveExport = resolve; }));
  act(() => window.dispatchEvent(new Event("pagehide")));
  await act(async () => resolveExport?.({ privateKey: "late-private-key" }));
  expect(screen.queryByLabelText("Exported private key")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Export private key with biometrics" }),
  );
  await act(async () => resolveExport?.({ privateKey: "fresh-private-key" }));
  expect(screen.getByLabelText("Exported private key")).toBeTruthy();
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(screen.queryByLabelText("Exported private key")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_credential_auth", undefined, { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it("hands a verified SSH connection to Mosh before exposing terminal input", async () => {
  verifiedMoshControl();
  mocks.api.connectMosh.mockResolvedValue({ sessionId: "mosh-terminal" });
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText("Transport"), "mosh");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
  expect(mocks.api.connectMosh).toHaveBeenCalledWith(
    "ssh-control",
    { serverPath: "mosh-server", portMin: 60000, portMax: 61000 },
    expect.any(Function),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(localStorage.setItem).toHaveBeenCalledWith(
    "lazysh.workspace.v1",
    JSON.stringify([
      {
        hostId: "home",
        mosh: { serverPath: "mosh-server", portMin: 60000, portMax: 61000 },
      },
    ]),
  );
});

it("closes the SSH bootstrap when forced Mosh fails without falling back", async () => {
  verifiedMoshControl();
  mocks.api.connectMosh.mockRejectedValue(
    new Error("Mosh UDP connection failed"),
  );
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText("Transport"), "mosh");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Mosh UDP connection failed")).toBeTruthy();
  expect(screen.queryByText("Live SSH terminal")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
});

it("cancels the SSH control session during Mosh bootstrap and closes a late result", async () => {
  verifiedMoshControl();
  let finish: ((value: { sessionId: string }) => void) | undefined;
  mocks.api.connectMosh.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText("Transport"), "mosh");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(mocks.api.connectMosh).toHaveBeenCalled());
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  await act(async () => finish?.({ sessionId: "late-mosh" }));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"late-mosh"});
  expect(screen.queryByText("Live SSH terminal")).toBeNull();
});

it("opens a fresh ET transport through verified SSH and preserves only reconnect options", async () => {
  mocks.invoke.mockImplementation(async(command:string)=>command==='transport_capabilities'?{et:true,mosh:true}:false);
  mocks.api.connect.mockResolvedValue({sessionId:'ssh-control'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'et-terminal'});
  const user=await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'et');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectEt).toHaveBeenCalledWith('ssh-control',{serverPath:'etterminal',port:2022},expect.any(Function));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home',et:{serverPath:'etterminal',port:2022}}]));
});

const autoOptions = {
  mosh: {serverPath:'mosh-server', portMin:60000, portMax:61000},
  et: {serverPath:'etterminal', port:2022},
};
function enableTransports() {
  mocks.invoke.mockImplementation(async(command:string)=>command==='transport_capabilities'?{mosh:true,et:true}:false);
  mocks.api.connect.mockResolvedValue({sessionId:'verified-control'});
}
async function connectAuto() {
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'auto');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  return user;
}
it('Auto selects authenticated Mosh first and persists the Auto intention',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockResolvedValue({sessionId:'auto-mosh'});
  await connectAuto();
  expect(await screen.findByText('Auto selected Mosh.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home',auto:autoOptions}]));
});
it('Auto reports Mosh UDP failure and tries ET on the same verified SSH connection',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_udp_unreachable',message:'No authenticated UDP reply'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'auto-et'});
  await connectAuto();
  expect(await screen.findByText('Auto selected Eternal Terminal. Mosh: No authenticated UDP reply.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  expect(mocks.api.connectMosh).toHaveBeenCalledWith('verified-control',autoOptions.mosh,expect.any(Function));
  expect(mocks.api.connectEt).toHaveBeenCalledWith('verified-control',autoOptions.et,expect.any(Function));
});
it('Auto reports both observed failures and keeps the existing SSH terminal',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_bootstrap',message:'Mosh executable is missing'});
  mocks.api.connectEt.mockRejectedValue({kind:'et_unreachable',message:'ET TCP port is closed'});
  await connectAuto();
  expect(await screen.findByText('Auto selected SSH. Mosh: Mosh executable is missing; Eternal Terminal: ET TCP port is closed.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  expect(mocks.api.disconnect).not.toHaveBeenCalledWith('verified-control');
});
it('Auto stops for SSH host trust without attempting a secondary transport',async()=>{
  enableTransports();
  mocks.api.connect.mockRejectedValue({kind:'unknown_host_key',fingerprint:'SHA256:unverified',message:'Verify this server'});
  await connectAuto();
  expect(await screen.findByText('SHA256:unverified')).toBeTruthy();
  expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
});
it.each(['authentication_failed','host_key_changed','cancelled','unclassified'])('Auto stops on %s instead of treating it as transport unavailability',async(kind)=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind,message:'Connection blocked'});
  await connectAuto();
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"}));
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
});
it('Auto never falls back from ET packet authentication failure',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_bootstrap',message:'Mosh not installed'});
  mocks.api.connectEt.mockRejectedValue({kind:'et_authentication',message:'ET packet authentication failed'});
  await connectAuto();
  expect(await screen.findByText('ET packet authentication failed')).toBeTruthy();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
});
it('closing Auto during Mosh prevents a late failed attempt from starting ET',async()=>{
  enableTransports();
  let reject:((error:unknown)=>void)|undefined;
  mocks.api.connectMosh.mockImplementation(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  const user=await connectAuto();
  await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  await act(async()=>reject?.({kind:'mosh_udp_unreachable',message:'Late UDP timeout'}));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
});
it('Auto explicitly skips unsupported transports for a bastion route',async()=>{
  enableTransports();
  mocks.api.listHosts.mockResolvedValue([{...host,jumpHostId:'gateway'}]);
  await connectAuto();
  expect(await screen.findByText('Auto selected SSH. Mosh: bastion routes use SSH; Eternal Terminal: bastion routes use SSH.')).toBeTruthy();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
});
it('loads a named host forced ET preference without changing its connection mode',async()=>{
  enableTransports();
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'et',et:{serverPath:'/opt/etterminal',port:2122}}]);
  mocks.api.connectEt.mockResolvedValue({sessionId:'preferred-et'});
  const user=await openConnection();
  expect((screen.getByLabelText('Transport') as HTMLSelectElement).value).toBe('et');
  expect((screen.getByLabelText('ET terminal path') as HTMLInputElement).value).toBe('/opt/etterminal');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectEt).toHaveBeenCalledWith('verified-control',{serverPath:'/opt/etterminal',port:2122},expect.any(Function));
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.saveHost).not.toHaveBeenCalled();
});
it('forced ET fails visibly without falling back to SSH',async()=>{
  enableTransports();
  mocks.api.connectEt.mockRejectedValue({kind:'et_unreachable',message:'ET port unreachable'});
  const user=await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'et');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('ET port unreachable')).toBeTruthy();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
});
it('edits the named host transport and helper options through the native host API',async()=>{
  mocks.api.saveHost.mockResolvedValue(host);
  const user=userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  await user.selectOptions(screen.getByLabelText('Preferred transport'),'auto');
  await user.clear(screen.getByLabelText('Mosh server path'));
  await user.type(screen.getByLabelText('Mosh server path'),'/opt/mosh-server');
  await user.clear(screen.getByLabelText('ET server port'));
  await user.type(screen.getByLabelText('ET server port'),'2122');
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalledWith({...host,transport:'auto',mosh:{...autoOptions.mosh,serverPath:'/opt/mosh-server'},et:{...autoOptions.et,port:2122}}));
});
it('restores Auto by probing transports again rather than restoring its last SSH fallback',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_udp_unreachable',message:'UDP blocked again'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'restored-et'});
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',auto:autoOptions}]):null);
  const user=userEvent.setup();
  render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  expect(await screen.findByText('Auto selected Eternal Terminal. Mosh: UDP blocked again.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledWith('home',{},expect.any(Function),{useSavedCredentials:true});
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
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
  await user.click(screen.getByRole('button',{name:'Apple status'}));
  expect(await screen.findByText('Apple controls for apple-current')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Review Apple approval'}));
  expect(await screen.findByText('Agent companion')).toBeTruthy();
});
it('honors the connection shortcut and protects credential dialogs from global shortcuts',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.keyboard('{Control>}n{/Control}');
  expect(screen.getByLabelText('Search saved hosts')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:/Home.*dev@home.local/}));
  await user.click(screen.getByLabelText('Password'));
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.queryByLabelText('Search saved hosts')).toBeNull();
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
it('closes late Auto restoration results when the app unmounts',async()=>{
  enableTransports();
  let complete:((value:{sessionId:string})=>void)|undefined;
  mocks.api.connectMosh.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',auto:autoOptions}]):null);
  const user=userEvent.setup();
  const rendered=render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  rendered.unmount();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
  await act(async()=>complete?.({sessionId:'late-restore'}));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"late-restore"});
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
});

it('waits for native capabilities before starting Auto discovery',async()=>{
  let resolveCapabilities:((value:{mosh:boolean;et:boolean})=>void)|undefined;
  mocks.invoke.mockImplementation((command:string)=>command==='transport_capabilities'?new Promise(resolve=>{resolveCapabilities=resolve;}):Promise.resolve(false));
  mocks.api.connect.mockResolvedValue({sessionId:'verified-control'});
  mocks.api.connectMosh.mockResolvedValue({sessionId:'ready-mosh'});
  const user=await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'auto');
  expect((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.api.connect).not.toHaveBeenCalled();
  await act(async()=>resolveCapabilities?.({mosh:true,et:true}));
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Auto selected Mosh.')).toBeTruthy();
});

function enableLocal() {
  mocks.invoke.mockImplementation(async(command:string)=>command==='local_capability'?{available:true,reason:'Local desktop shell'}:false);
  mocks.api.connectLocal.mockResolvedValue({sessionId:'local:desktop'});
}
it.each(['preparation','native'] as const)('interprets launch codes only at the native connect boundary: %s',async source=>{
  enableLocal();
  const receipt='7b6d0fc9-a755-4e10-b2e3-0dbdc1259326';
  mocks.launchReceipt=receipt;
  if(source==='preparation')mocks.prepareError='LOCAL_LAUNCH_UNAVAILABLE';
  else mocks.api.connectLocal.mockRejectedValueOnce('LOCAL_LAUNCH_UNAVAILABLE');
  render(<App/>);
  const alert=await screen.findByRole('alert');
  expect(alert.querySelector('span')?.textContent).toBe(source==='preparation'?'LOCAL_LAUNCH_UNAVAILABLE':'This launch request is no longer available. Run the command again.');
  if(source==='preparation')expect(mocks.api.connectLocal).not.toHaveBeenCalled();
  else expect(mocks.api.connectLocal).toHaveBeenCalledExactlyOnceWith(expect.any(Function),receipt);
});
it('opens an explicit local terminal without SSH authentication and hides remote tools',async()=>{
  enableLocal();const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectLocal).toHaveBeenCalledTimes(1);expect(mocks.api.connect).not.toHaveBeenCalled();
  expect(mocks.api.connectLocal).toHaveBeenCalledWith(expect.any(Function));
  expect(screen.getByText(/Local PTY/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Files'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Agents'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Apple status'})).toBeNull();
  expect(screen.queryByText('Apple controls for local:desktop')).toBeNull();
  expect(mocks.accountUsageSession).toHaveBeenLastCalledWith('local:desktop');
  await user.click(screen.getByRole('button',{name:'Open AI account usage'}));
  expect(await screen.findByRole('region',{name:'AI account usage'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Use latest report for Watch'})).toBeNull();
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.workspace.v1','[{"local":true}]');
  await user.click(screen.getByRole('button',{name:'Disconnect Local terminal'}));
  expect(mocks.api.disconnect).toHaveBeenCalledWith('local:desktop');
});
it('keeps the local entry unavailable when the native platform reports unsupported',async()=>{
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  expect((screen.getByRole('button',{name:'Open local terminal'}) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button',{name:'Open local terminal'}));
  expect(mocks.api.connectLocal).not.toHaveBeenCalled();
});
it('restores local intention through a fresh local PTY without a host lookup or SSH',async()=>{
  enableLocal();vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?'[{"local":true}]':null);
  mocks.api.listHosts.mockResolvedValue([]);
  const user=userEvent.setup();render(<App/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Open local terminal'}) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  expect(await screen.findByText(/Local PTY/)).toBeTruthy();expect(mocks.api.connectLocal).toHaveBeenCalledTimes(1);
  expect(mocks.api.connectLocal).toHaveBeenCalledWith(expect.any(Function));
  expect(mocks.api.connect).not.toHaveBeenCalled();
});
it('disconnects a late local startup when the app closes',async()=>{
  enableLocal();let finish:((value:{sessionId:string})=>void)|undefined;
  mocks.api.connectLocal.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=userEvent.setup();const view=render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));
  await waitFor(()=>expect(mocks.api.connectLocal).toHaveBeenCalled());view.unmount();
  await act(async()=>finish?.({sessionId:'local:late'}));
  expect(mocks.invoke).toHaveBeenCalledWith("local_disconnect", {sessionId:"local:late"});
});

it('keeps explicit Apple sharing mounted across tool navigation and binds the selected usage to its SSH session',async()=>{
  mocks.api.connect.mockResolvedValueOnce({sessionId:'usage-one'}).mockResolvedValueOnce({sessionId:'usage-two'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Apple status'}));await user.click(screen.getByRole('button',{name:'Start test Apple sharing'}));
  await user.click(screen.getByRole('button',{name:'Usage'}));await user.click(await screen.findByRole('button',{name:'Use latest report for Watch'}));
  expect(mocks.appleProps).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:'usage-one',usage:{recordedAt:'2026-10-25T12:00:00Z',freshness:'fresh',inputTokens:11,outputTokens:9,cacheReadTokens:null,cacheWriteTokens:2,observedAt:'2026-10-25T12:01:00Z',receivedAt:1792929660000}}));
  await user.click(screen.getByRole('button',{name:'Apple status'}));expect(screen.getByText('Apple sharing remains active')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));await user.type(screen.getByLabelText('Password'),'second-secret');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.appleProps).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:'usage-two',usage:null})));
  expect(localStorage.setItem).not.toHaveBeenCalledWith('lazysh.workspace.v1',expect.stringContaining('inputTokens'));
});

async function voiceConnection(id='dictation-current'){
  mocks.api.connect.mockResolvedValue({sessionId:id});mocks.api.write.mockResolvedValue(undefined);
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');await user.click(screen.getByRole('button',{name:'Dictate'}));
  await screen.findByText(`Voice for ${id}`);
  return {user,deliver:mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation as (request:import('./voiceDelivery').DirectDictation)=>Promise<void>};
}
it('delivers one bounded final payload to the exact current terminal and lets a failed write remain failed',async()=>{
  const {deliver}=await voiceConnection();
  const claim=vi.fn().mockReturnValue(true);
  await deliver({sessionId:'dictation-current',text:'echo 世界',autoSend:true,claim});
  expect(mocks.api.write).toHaveBeenCalledExactlyOnceWith('dictation-current','echo 世界\r');expect(claim).toHaveBeenCalledOnce();
  mocks.api.write.mockRejectedValueOnce(new Error('queue full'));
  await expect(deliver({sessionId:'dictation-current',text:'second',autoSend:false,claim})).rejects.toThrow('queue full');
  expect(mocks.api.write).toHaveBeenCalledTimes(2);
});
it('rejects wrong sessions, unsafe input and foreground/generation changes before any write',async()=>{
  const {deliver}=await voiceConnection();
  const claim=vi.fn().mockReturnValue(true);
  await expect(deliver({sessionId:'other-session',text:'wrong',autoSend:true,claim})).rejects.toThrow('no longer active');expect(claim).not.toHaveBeenCalled();
  expect(()=>deliver({sessionId:'dictation-current',text:'bad\ncommand',autoSend:true,claim})).toThrow('one line');
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
  await expect(deliver({sessionId:'dictation-current',text:'hidden',autoSend:true,claim})).rejects.toThrow('no longer active');
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  claim.mockReturnValue(false);
  await expect(deliver({sessionId:'dictation-current',text:'cancelled',autoSend:true,claim})).rejects.toThrow('no longer active');
  expect(mocks.api.write).not.toHaveBeenCalled();
});
it('rejects a held callback after navigation away, disconnect, or App unmount',async()=>{
  const {deliver,user}=await voiceConnection();const request={sessionId:'dictation-current',text:'old command',autoSend:true,claim:()=>true};
  await user.click(screen.getByRole('button',{name:'Terminal'}));
  await expect(deliver(request)).rejects.toThrow('no longer active');
  await user.click(screen.getByRole('button',{name:'Dictate'}));await screen.findByText('Voice for dictation-current');
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  await expect(deliver(request)).rejects.toThrow('no longer active');
  cleanup();await expect(deliver(request)).rejects.toThrow('no longer active');expect(mocks.api.write).not.toHaveBeenCalled();
});
it('preserves local session identity for direct input',async()=>{
  enableLocal();mocks.api.write.mockResolvedValue(undefined);const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Dictate'}));await screen.findByText('Voice for local:desktop');
  await mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation({sessionId:'local:desktop',text:'pwd',autoSend:false,claim:()=>true});
  expect(mocks.api.write).toHaveBeenCalledExactlyOnceWith('local:desktop','pwd');
});

it('invalidates direct delivery synchronously on disconnect intent and never revives it after failure',async()=>{
  const {deliver,user}=await voiceConnection();
  let reject!:(error:Error)=>void;
  mocks.api.disconnect.mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  const request={sessionId:'dictation-current',text:'late command',autoSend:true,claim:vi.fn().mockReturnValue(true)};
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  await expect(deliver(request)).rejects.toThrow('no longer active');expect(request.claim).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));expect(mocks.api.disconnect).toHaveBeenCalledOnce();
  await user.click(await screen.findByRole('button',{name:'Workspace tools'}));
  const during=mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation;
  await user.keyboard('{Escape}');
  await act(async()=>reject(new Error('disconnect failed')));
  await expect(deliver(request)).rejects.toThrow('no longer active');
  await expect(during(request)).rejects.toThrow('no longer active');
  expect(mocks.api.write).not.toHaveBeenCalled();
  const fresh=mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation;
  await fresh({...request,text:'new recording',autoSend:false});
  expect(mocks.api.write).toHaveBeenCalledExactlyOnceWith('dictation-current','new recording');
  let rejectAgain!:(error:Error)=>void;
  mocks.api.disconnect.mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{rejectAgain=fail;}));
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  await act(async()=>rejectAgain(new Error('disconnect failed')));
  await expect(fresh(request)).rejects.toThrow('no longer active');
  await mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation({...request,text:'recording after repeated failure',autoSend:false});
  expect(mocks.api.write).toHaveBeenLastCalledWith('dictation-current','recording after repeated failure');
});

it('retains only class-branded global failures across locales and preserves every other payload conversion',async()=>{
  render(<App/>);await screen.findByRole('button',{name:'Connect to Home'});
  try{
    act(()=>{window.dispatchEvent(new CustomEvent('lazysh-error',{detail:new LocalUiError('shareCompletedWhileClosing')}));});
    for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});expect(screen.getByRole('alert').textContent).toContain(t('shareCompletedWhileClosing'));}
    for(const detail of ['shareCompletedWhileClosing <raw> {{name}}',{key:'shareCompletedWhileClosing',message:'Never trust this key'}]){
      act(()=>{window.dispatchEvent(new CustomEvent('lazysh-error',{detail}));});
      for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});expect(screen.getByRole('alert').textContent).toContain(String(detail));expect(screen.getByRole('alert').textContent).not.toContain('Never trust this key');}
    }
  }finally{await act(async()=>{await uiI18n.changeLanguage('en');});}
});

it.each(['tmux','herdr','zellij'] as const)('enters the saved named %s directly through SSH and retires only its bootstrap',async kind=>{
  const target={kind,name:kind==='herdr' ? 'named-work' : "work 'literal;"};
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'mosh',defaultMultiplexer:target}]);
  mocks.api.connect.mockResolvedValue({sessionId:'default-parent'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'default-child'});
  const user=await openConnection();
  expect(screen.getByLabelText('Transport')).toHaveProperty('value','ssh');
  expect(screen.getByLabelText('Transport')).toHaveProperty('disabled',true);
  expect(screen.getByText(/Direct multiplexer entry uses SSH. The saved transport preference is unchanged./)).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.attachDefaultMultiplexer).toHaveBeenCalledExactlyOnceWith('default-parent',target,expect.any(Function));
  expect(mocks.api.adoptSession).toHaveBeenCalledWith('default-child');
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='disconnect')).toEqual([['disconnect',{sessionId:'default-parent'}]]);
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(mocks.api.saveHost).not.toHaveBeenCalled();
});
it('shows a selected multiplexer preflight failure and closes its bootstrap without adopting a blank terminal',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,defaultMultiplexer:{kind:'zellij',name:'work'}}]);
  mocks.api.connect.mockResolvedValue({sessionId:'unavailable-parent'});
  mocks.api.attachDefaultMultiplexer.mockRejectedValue({kind:'multiplexer_unavailable',message:'Selected multiplexer unavailable'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Selected multiplexer unavailable');
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'unavailable-parent'});
  expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
});
it('keeps explicit desktop host launch semantics ahead of the saved default',async()=>{
  enableHostLaunch({...host,defaultMultiplexer:{kind:'herdr',name:'saved'}});
  mocks.api.connect.mockResolvedValue({sessionId:'explicit-host'});
  const user=userEvent.setup();render(<App/>);
  await user.type(await screen.findByLabelText('Password'),'explicit');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.attachDefaultMultiplexer).not.toHaveBeenCalled();
  expect(mocks.api.connect).toHaveBeenCalledWith(host.id,{password:'explicit'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
});
it('persists and removes the host default without changing the saved transport',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'et'}]);
  mocks.api.saveHost.mockImplementation(async value=>value);
  const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  await user.selectOptions(screen.getByLabelText('Default multiplexer'),'tmux');
  await user.type(screen.getByLabelText('Default multiplexer session'),'new-work');
  expect(screen.getByText('Attach to the named session, or create it using the selected multiplexer. No other session is selected.')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalled());
  const saved=mocks.api.saveHost.mock.calls[0][0];
  expect(saved).toMatchObject({transport:'et',defaultMultiplexer:{kind:'tmux',name:'new-work'}});
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  await user.selectOptions(screen.getByLabelText('Default multiplexer'),'');
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalledTimes(2));
  expect(mocks.api.saveHost.mock.calls[1][0]).toMatchObject({transport:'et',defaultMultiplexer:undefined});
});
it('opens the active host multiplexer setting directly from workspace tools without changing its running session',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,id:'other-host',name:'Other'},{...host,transport:'mosh'}]);
  mocks.api.connect.mockResolvedValue({sessionId:'settings-current'});
  mocks.api.saveHost.mockResolvedValue(undefined);
  const user=await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'ssh');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  const terminal=await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  await user.click(screen.getByRole('button',{name:'Default multiplexer'}));
  const editor=await screen.findByRole('dialog',{name:'Edit host'});
  const setting=within(editor).getByLabelText('Default multiplexer');
  expect(document.activeElement).toBe(setting);
  expect(within(editor).getByLabelText('Name')).toHaveProperty('value','Home');
  await user.selectOptions(setting,'herdr');
  await user.type(within(editor).getByLabelText('Default multiplexer session'),'named-work');
  await user.click(within(editor).getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Edit host'})).toBeNull());
  expect(mocks.api.saveHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:host.id,transport:'mosh',defaultMultiplexer:{kind:'herdr',name:'named-work'}}));
  expect(screen.getByText('Live SSH terminal')).toBe(terminal);
  expect(mocks.api.connect).toHaveBeenCalledOnce();
  expect(mocks.api.disconnect).not.toHaveBeenCalled();
  expect(mocks.api.attachDefaultMultiplexer).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Edit Home'}));
  expect(document.activeElement).not.toBe(screen.getByLabelText('Default multiplexer'));
});
it.each([{kind:'tmux',name:'bad.name'},{kind:'tmux',name:'bad:name'},{kind:'herdr',name:' '},{kind:'herdr',name:'bad name'},{kind:'herdr',name:'..'},{kind:'herdr',name:'a'.repeat(65)},{kind:'zellij',name:'--option'},{kind:'herdr',name:'é'.repeat(101)},{kind:'other',name:'work'}])('rejects invalid saved default %j before native save',target=>{
  expect(validateHost({...host,defaultMultiplexer:target as Host['defaultMultiplexer']})).toBeTruthy();
});

it('retires a late default child after its connection dialog closes',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,defaultMultiplexer:{kind:'herdr',name:'late'}}]);
  mocks.api.connect.mockResolvedValue({sessionId:'late-bootstrap'});
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.attachDefaultMultiplexer.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.api.attachDefaultMultiplexer).toHaveBeenCalled());
  await user.click(screen.getByRole('button',{name:'Close Connect to Home'}));
  await act(async()=>finish({sessionId:'late-mux-child'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'late-mux-child'}));
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'late-bootstrap'});
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();
});
it('keeps one agent owner beside the owned terminal and suspends it through navigation without losing drafts',async()=>{
  reportedHistoryApp(reportedAppMetadata);mocks.api.connect.mockResolvedValue({sessionId:'nav-agents'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  expect(screen.getByRole('button',{name:'Connections'})).toHaveProperty('ariaCurrent','page');
  await user.click(screen.getByRole('button',{name:'Agents'}));
  const search=await screen.findByRole('searchbox',{name:'Search reported agents'});await user.type(search,'/project');
  const settings=await screen.findByRole('checkbox',{name:'Recorded usage inspection'});await user.click(settings);
  expect(screen.getByText('Live SSH terminal')).toBeTruthy();
  expect(screen.getAllByRole('region',{name:'Agent activity'})).toHaveLength(1);
  await user.click(screen.getByRole('button',{name:'Connections'}));
  expect(screen.queryByRole('region',{name:'Agent activity'})).toBeNull();
  const reads=mocks.invoke.mock.calls.filter(([command])=>command==='agent_snapshot').length;
  await user.click(screen.getByRole('button',{name:'Agents navigation'}));
  await screen.findByRole('searchbox');expect(screen.getByRole('searchbox')).toBe(search);expect(search).toHaveProperty('value','/project');
  expect(settings).toHaveProperty('checked',false);
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='get_companion_settings')).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='agent_snapshot')).toHaveLength(reads+1);
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.api.connect).toHaveBeenCalledOnce();
});
it('keeps late picker cleanup scoped while a new source is busy, then admits queued CLI intent once the wide picker is idle',async()=>{
  enableHostLaunch({...host,defaultMultiplexer:{kind:'tmux',name:'work'}});mocks.hostLaunchReceipt=null;
  const original=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,...args)=>command==='multiplexer_tree'?Promise.resolve({tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,sessions:[{id:'$1',name:'other',windows:[]}]}):original(command,...args));
  mocks.api.connect.mockResolvedValue({sessionId:'nav-control'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'nav-display-a'});
  mocks.api.attachTmux.mockResolvedValue({sessionId:'nav-display-b'});
  const pending=new Map<string,(value:typeof navigationSnapshot)=>void>();
  mocks.api.tmuxJumpSnapshot.mockImplementation(id=>new Promise(resolve=>pending.set(id,resolve)));
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Jump To'}));await waitFor(()=>expect(pending.has('nav-display-a')).toBe(true));
  // The bootstrap is retired by direct entry. Open a second owned display through the existing manager.
  await user.click(screen.getByRole('button',{name:'Open session manager'}));
  await user.click(await screen.findByRole('button',{name:'Attach other'}));
  await user.click(await screen.findByRole('button',{name:'Jump To'}));await waitFor(()=>expect(pending.has('nav-display-b')).toBe(true));
  mocks.hostLaunchReceipt=hostLaunchReceipt;await act(async()=>{mocks.launchEvent!({payload:null});});
  expect(screen.queryByRole('dialog',{name:'Connect to Home'})).toBeNull();
  await act(async()=>{pending.get('nav-display-a')!(navigationSnapshot);});
  expect(screen.queryByRole('dialog',{name:'Connect to Home'})).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(0);
  await act(async()=>{pending.get('nav-display-b')!(navigationSnapshot);});
  await screen.findByRole('dialog',{name:'Connect to Home'});
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(1);
  expect(mocks.api.attachTmux).toHaveBeenCalledWith('nav-display-a','other',expect.any(Function),undefined);
});
it('keeps a requested desktop mux manager and its lease while workspace navigation is unavailable',async()=>{
  enableMuxLaunch({kind:'tmux',tmuxServer:'default'});
  const user=userEvent.setup();render(<App/>);await user.type(await screen.findByLabelText('Password'),'entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByRole('button',{name:'Attach chosen'});
  expect(screen.getByRole('button',{name:'Workspaces'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Agents navigation'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Agents'})).toHaveProperty('disabled',true);
  expect(mocks.api.tmuxJumpSnapshot).not.toHaveBeenCalled();
  expect(mocks.api.attachTmux).not.toHaveBeenCalled();
  expect(mocks.api.connect).toHaveBeenCalledWith(host.id,{password:'entry'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
});

it.each([
  {name:'restored',response:{schemaVersion:1,status:'restored'},valid:true},
  {name:'missing',response:undefined,valid:false},
  {name:'wrong schema',response:{schemaVersion:2,status:'restored'},valid:false},
  {name:'uncertain status',response:{schemaVersion:1,status:'uncertain'},valid:false},
  {name:'extra field',response:{schemaVersion:1,status:'restored',extra:true},valid:false},
].flatMap(item=>(['files','hostTools'] as const).map(purpose=>({...item,purpose}))))('validates $name $purpose recovery without creating or adopting a terminal',async({response,valid,purpose})=>{
  const user=userEvent.setup(),restored=vi.fn(),connected=vi.fn();
  const restore=purpose==='files'?mocks.api.restoreFileTransfer:mocks.api.restoreHostTools;
  restore.mockResolvedValue(response);
  render(<ConnectDialog host={{...host,transport:'mosh'}} hosts={[host]} connected={connected} close={vi.fn()} recovery={{sessionId:'original-mosh',purpose,restored}}/>);
  expect(screen.queryByLabelText('Transport')).toBeNull();
  expect(screen.queryByText('Save credentials on this device after connecting')).toBeNull();
  await user.type(screen.getByLabelText('Password'),'ephemeral-restore');
  await user.click(screen.getByRole('button',{name:t(purpose==='files'?'attachmentRestore':'hostToolsRestore')}));
  if(valid)await waitFor(()=>expect(restored).toHaveBeenCalledOnce());
  else {expect(await screen.findByRole('alert')).toHaveProperty('textContent',t(purpose==='files'?'attachmentRestoreInvalid':'hostToolsRestoreInvalid'));expect(restored).not.toHaveBeenCalled();}
  expect(restore).toHaveBeenCalledWith('original-mosh',{password:'ephemeral-restore'},{useSavedCredentials:false});
  expect(purpose==='files'?mocks.api.restoreHostTools:mocks.api.restoreFileTransfer).not.toHaveBeenCalled();
  expect(mocks.api.connect).not.toHaveBeenCalled();expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();expect(mocks.createTerminal).not.toHaveBeenCalled();expect(connected).not.toHaveBeenCalled();
});

it('uses existing saved credential authorization for upload recovery and suppresses stale completion after lock',async()=>{
  const user=userEvent.setup(),restored=vi.fn();let complete!:(value:{schemaVersion:1;status:'restored'})=>void;
  mocks.invoke.mockImplementation(async command=>command==='has_credentials');
  mocks.api.restoreFileTransfer.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  render(<ConnectDialog host={{...host,credentialsStored:true,biometricUnlock:true}} hosts={[host]} connected={vi.fn()} close={vi.fn()} recovery={{sessionId:'original-mosh',restored}}/>);
  expect(await screen.findByLabelText('Use saved credentials')).toHaveProperty('checked',true);
  await user.click(screen.getByRole('button',{name:'Reconnect uploads'}));
  expect(mocks.api.restoreFileTransfer).toHaveBeenCalledWith('original-mosh',{}, {useSavedCredentials:true});
  await act(async()=>{
    applyAccessStatus({...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined});
    complete({schemaVersion:1,status:'restored'});
  });
  expect(restored).not.toHaveBeenCalled();expect(mocks.api.connect).not.toHaveBeenCalled();expect(mocks.api.disconnect).not.toHaveBeenCalled();
});

it.each(['lock','hidden','closed-source','unmount'] as const)('does not publish late host-tools recovery after %s',async mode=>{
  applyAccessStatus(unlockedStatus());
  const user=userEvent.setup(),restored=vi.fn(),current=vi.fn(()=>true);let complete!:(value:{schemaVersion:1;status:'restored'})=>void;
  mocks.api.restoreHostTools.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const view=render(<ConnectDialog host={host} hosts={[host]} connected={vi.fn()} close={vi.fn()} recovery={{sessionId:'original-mosh',purpose:'hostTools',current,restored}}/>);
  await user.type(screen.getByLabelText('Password'),'ephemeral-tools');
  await user.click(screen.getByRole('button',{name:t('hostToolsRestore')}));
  expect(mocks.api.restoreHostTools).toHaveBeenCalledWith('original-mosh',{password:'ephemeral-tools'},{useSavedCredentials:false});
  if(mode==='hidden'){
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    act(()=>document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  }else if(mode==='lock')applyAccessStatus({...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined});
  else if(mode==='closed-source')current.mockReturnValue(false);
  else view.unmount();
  await act(async()=>complete({schemaVersion:1,status:'restored'}));
  expect(restored).not.toHaveBeenCalled();expect(mocks.api.connect).not.toHaveBeenCalled();expect(mocks.api.restoreFileTransfer).not.toHaveBeenCalled();
});
