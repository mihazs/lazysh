// @vitest-environment jsdom
import {t} from '../i18n/core';
import {afterEach, beforeEach, vi} from "vitest";
import {cleanup, render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {Host, TransportMode} from "../bridge";
import App from "../App";
import {captureAccess} from '../access';

vi.mock('../../package.json',()=>({default:{version:'2.3.4'}}));

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
  installMoshResize: vi.fn(),
  invoke: vi.fn(),
  accountUsageSession: vi.fn(),
  accountUsageRefresh: vi.fn(),
  accountUsageDisconnected: false,
  accountUsageCompanionRequired: false,
  terminalPaneProps: vi.fn(),
  backButton: undefined as undefined | ((payload:{canGoBack:boolean})=>void),
  unregisterBack: vi.fn(),
  appleProps: vi.fn(),
  voiceProps: vi.fn(),
  realAgents:false,
  launchReceipt: null as string|null,
  hostLaunchReceipt: null as string|null,
  prepareError: null as string|null,
  launchEvent: undefined as undefined|((event:{payload:unknown})=>void),
  lockEvent: undefined as undefined | ((event: { payload: unknown }) => void),
}));

// vitest rejects `export const` on a hoisted variable.
export {mocks};

export let generationBase=0;

export const unlockedStatus = () => ({initialized:true,supported:true,reason:'',enabled:false,locked:false,generation:String(generationBase),nonce:'a'.repeat(64)});

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

vi.mock('@tauri-apps/api/app',async original=>({...await original<typeof import('@tauri-apps/api/app')>(),onBackButtonPress:vi.fn(async handler=>{
  mocks.backButton=handler;
  return {unregister:async()=>{mocks.unregisterBack();if(mocks.backButton===handler)mocks.backButton=undefined;}};
})}));

vi.mock("../bridge", () => ({ native: true, api: mocks.api }));

vi.mock('../useAccountUsage',()=>({useAccountUsage:(sessionId:string|null)=>{mocks.accountUsageSession(sessionId);return {response:{schemaVersion:1,state:mocks.accountUsageCompanionRequired?'companion_required':mocks.accountUsageDisconnected?'disconnected':'ready',source:'builtin',report:{primary:null,entries:[]}},refreshing:false,refresh:mocks.accountUsageRefresh,entry:null,select:()=>{}};}}));

// The status bar's pane-agent read has its own tests; here it would share the mocked Herdr snapshots the Agent view tests count.
vi.mock('../useCurrentPaneAgent',()=>({useCurrentPaneAgent:()=>null}));

vi.mock("../xterm/terminal", async importOriginal => ({...await importOriginal<typeof import("../xterm/terminal")>(), createTerminal: () => mocks.createTerminal()}));

vi.mock("../xterm/moshResize", () => ({installMoshResize: (...args:unknown[])=>mocks.installMoshResize(...args)}));

vi.mock("../TerminalPane", () => ({
  default: (props: { active: boolean; onOpenAttachments?:()=>void }) => {
    mocks.terminalPaneProps(props);
    return props.active ? <div>Live SSH terminal</div> : null;
  },
}));

vi.mock('../AgentPanel',async original=>{
  const actual=await original<typeof import('../AgentPanel')>();
  const {captureAccess}=await import('../access');
  return {...actual,default:(props:React.ComponentProps<typeof actual.AgentPanel>)=>mocks.realAgents?<actual.AgentPanel {...props}/>:<>{props.renderNavigation?.({host:undefined,available:false,rows:[],lease:captureAccess()})}<div ref={props.activityRef} id={props.activityId} role="group" aria-label={t('agentsReportedActivity')} tabIndex={-1} hidden={!props.visible}>Agent companion</div></>};
});

vi.mock('../PushSettingsPanel',()=>({default:()=> <div>Native push registration controls</div>}));

vi.mock('../AppleStatusPanel',async()=>{
  const {useState}=await import('react');
  return {default:(props:{sessionId:string;usage?:unknown;onReview:()=>void})=>{
    const [sharing,setSharing]=useState(false);mocks.appleProps(props);
    return <div>Apple controls for {props.sessionId}<button onClick={props.onReview}>Review Apple approval</button><button onClick={()=>setSharing(true)}>Start test Apple sharing</button>{sharing && <p>Apple sharing remains active</p>}</div>;
  }};
});

vi.mock('../UsagePanel',()=>({default:({onShareAppleUsage}:{onShareAppleUsage?:(report:unknown)=>void})=><button onClick={()=>onShareAppleUsage?.({recordedAt:'2026-10-25T12:00:00Z',freshness:'fresh',inputTokens:11,outputTokens:9,cacheReadTokens:null,cacheWriteTokens:2,observedAt:'2026-10-25T12:01:00Z',receivedAt:1792929660000})}>Use latest report for Watch</button>}));

vi.mock('../VoicePanel',()=>({default:(props:{sessionId:string;onDirectDictation:(request:import('../voiceDelivery').DirectDictation)=>Promise<void>})=>{mocks.voiceProps(props);return <div>Voice for {props.sessionId}</div>;}}));

export const host: Host = {
  id: "home",
  name: "Home",
  hostname: "home.local",
  port: 22,
  username: "dev",
};

beforeEach(() => {
  generationBase+=10;
  vi.clearAllMocks();mocks.realAgents=false;mocks.accountUsageDisconnected=false;mocks.accountUsageCompanionRequired=false;
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
  mocks.installMoshResize.mockImplementation(()=>({failure:null as null|'invalid-frame'|'partial-frame',close:vi.fn().mockResolvedValue(undefined),dispose:vi.fn()}));
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

export const reportedAgent={sessionId:'opaque-claude-row',agent:'Claude Code',project:'/project',state:'working',updatedAt:'2026-10-24T19:30:00Z',summary:'Reported work',paneId:'%7',eventCount:1};

export function reportedHistoryApp(response:unknown) {
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

export const reportedAppMetadata={schemaVersion:1,status:'available',sessionId:reportedAgent.sessionId,path:'/project/Claude 世界.jsonl ',reportedAt:'2026-10-24T19:30:00Z',paneId:'%7'};

export async function selectConnectionTransport(user:ReturnType<typeof userEvent.setup>, value:TransportMode) {
  const control = screen.getByLabelText('Transport');
  const options = control.closest('details');
  if (options && !options.open) await user.click(options.querySelector('summary')!);
  await user.selectOptions(control, value);
}

export async function openConnection(onStep?:(stage:'render-app'|'open-host-dialog'|'type-password')=>void) {
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

export async function connectForNavigation(sessionId:string){
  mocks.api.connect.mockResolvedValue({sessionId});
  const user=await openConnection();
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  return user;
}

export async function chooseWorkspaceTool(user:ReturnType<typeof userEvent.setup>,name:string) {
  await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  const dialog=screen.getByRole('dialog',{name:'Workspace tools'});
  const owner=Array.from(dialog.querySelectorAll<HTMLElement>('.workspace-tools-page')).find(page=>Array.from(page.querySelectorAll('button')).some(button=>button.textContent===name));
  if(owner?.getAttribute('aria-hidden')==='true')await user.click(dialog.querySelector<HTMLElement>(`[role=tab][aria-controls="${owner.id}"]`)!);
  await user.click(within(dialog).getByRole('button',{name}));
}

export const autoOptions = {
  mosh: {serverPath:'mosh-server', portMin:60000, portMax:61000},
  et: {serverPath:'etterminal', port:2022},
};

export function enableTransports() {
  mocks.invoke.mockImplementation(async(command:string)=>command==='transport_capabilities'?{mosh:true,et:true}:false);
  mocks.api.connect.mockResolvedValue({sessionId:'verified-control'});
}

export async function connectAuto() {
  const user = await openConnection();
  await selectConnectionTransport(user, 'auto');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  return user;
}
