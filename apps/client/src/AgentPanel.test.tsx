// @vitest-environment jsdom
import {StrictMode} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentPanel, parseReportedHistory, parseSnapshot,type ReportedHistorySource } from './AgentPanel';
import {applyAccessStatus} from './access';
import HerdrAgentsPanel,{parseHerdrAgents} from './HerdrAgentsPanel';
import {t,uiI18n} from './i18n/core';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(),Channel:class {onmessage?:unknown;}}));
vi.mock('./ApprovalPanel', () => ({default: () => null}));
const session = { sessionId: 'a', agent: 'Claude Code', project: '/work', state: 'needs_attention', updatedAt: '2026-10-24T19:30:00Z', summary: 'Permission requested', paneId: '%1', eventCount: 2 };
let generation=0;
function access(locked=false) {
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked,generation:String(++generation),...(locked?{}:{nonce:'a'.repeat(64)})});
}
function deferredRead() {
  let resolve!:(value:unknown)=>void,reject!:(reason:Error)=>void;
  const promise=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function pollingClock(run:(invoke:typeof import('@tauri-apps/api/core').invoke)=>Promise<void>) {
  vi.useFakeTimers();
  try {await run((await import('@tauri-apps/api/core')).invoke);}
  finally {cleanup();vi.useRealTimers();}
}
beforeEach(()=>{generation+=10;access();});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('agent activity', () => {
  it('accepts versioned snapshots and rejects malformed host data', () => {
    expect(parseSnapshot({ schemaVersion: 1, sessions: [session] })).toEqual([session]);
    for (const value of [null, { schemaVersion: 2, sessions: [] }, { schemaVersion: 1, sessions: [{ ...session, state: 'approved' }] }, { schemaVersion: 1, sessions: [{ ...session, eventCount: -1 }] }]) expect(() => parseSnapshot(value)).toThrow();
  });
  it('shows actual host events without an unimplemented approval action', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue({ schemaVersion: 1, sessions: [session] });
    render(<AgentPanel sessionId="ssh-one" />);
    expect(await screen.findByText('Permission requested')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('agent_snapshot', { sessionId: 'ssh-one' }, { headers: { "X-Lazysh-Access": expect.any(String) } });
    expect(screen.queryByRole('button', { name: /allow|approve/i })).toBeNull();
  });
  it('explains setup when the host companion is unavailable', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue({ message: 'lazysh-agent: command not found' });
    render(<AgentPanel sessionId="ssh-one" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Connect your agents.')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Install companion'})).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('get_companion_settings',expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } });
    expect(screen.queryByRole('region',{name:'Host companion settings'})).toBeNull();
  });
  it('verifies the new host companion before loading settings after a session change',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation((command,args)=>{
      if(command==='agent_snapshot')return args && 'sessionId' in args && args.sessionId==='new-host'?new Promise(()=>{}):Promise.resolve({schemaVersion:1,sessions:[]});
      return Promise.resolve({schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true});
    });
    const {rerender}=render(<AgentPanel sessionId="old-host"/>);
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('get_companion_settings',{sessionId:'old-host'}, { headers: { "X-Lazysh-Access": expect.any(String) } }));
    rerender(<AgentPanel sessionId="new-host"/>);
    expect(invoke).not.toHaveBeenCalledWith('get_companion_settings',{sessionId:'new-host'}, { headers: { "X-Lazysh-Access": expect.any(String) } });
    expect(screen.queryByRole('region',{name:'Host companion settings'})).toBeNull();
  });
});

const reported={schemaVersion:1,status:'available',sessionId:'a',path:'/work/Claude 世界.jsonl ',reportedAt:'2026-10-24T19:30:00Z',paneId:'%1'};
async function historyFixture(result:unknown, rows=[session]) {
  const {invoke}=await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:rows};
    if(command==='agent_reported_history')return typeof result==='function'?result(args):result;
    return {schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
  });
  return vi.mocked(invoke);
}
it('offers exact reported Claude history only after the selected row action and preserves raw metadata',async()=>{
  const invoke=await historyFixture(reported,[session,{...session,agent:'Codex',sessionId:'other',summary:'Other agent'}]);
  const route=vi.fn((_source:ReportedHistorySource)=>{});render(<AgentPanel sessionId="ssh-exact" onUseReportedHistory={route}/>);
  const row=await screen.findByText('Permission requested');
  expect(screen.getAllByRole('button',{name:'Use reported history'})).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(0);
  fireEvent.click(within(row.closest('article')!).getByRole('button',{name:'Use reported history'}));
  await waitFor(()=>expect(route).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith('agent_reported_history',{sessionId:'ssh-exact',agentSessionId:'a'},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  const source=route.mock.calls[0][0];expect(source).toMatchObject({sessionId:'ssh-exact',agentSessionId:'a',path:reported.path,reportedAt:reported.reportedAt,paneId:'%1'});
  expect(Object.isFrozen(source)).toBe(true);expect(source.lease.current()).toBe(true);
  expect(invoke.mock.calls.filter(([command])=>['agent_transcript','agent_transcripts'].includes(command))).toHaveLength(0);
});
it.each(['missing','ambiguous'] as const)('keeps the board/settings and manual fallback usable for %s metadata',async status=>{
  const invoke=await historyFixture({schemaVersion:1,status,sessionId:'a'});const route=vi.fn();
  render(<AgentPanel sessionId="ssh-one" onUseReportedHistory={route}/>);fireEvent.click(await screen.findByRole('button',{name:'Use reported history'}));
  await screen.findByText(t(status==='missing'?'agentsHistoryMissing':'agentsHistoryAmbiguous'));
  expect(screen.getByText(t('agentsHistoryManual'))).toBeTruthy();expect(screen.getByText('Permission requested')).toBeTruthy();
  expect(screen.getByRole('region',{name:'Host companion settings'})).toBeTruthy();expect(route).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await waitFor(()=>expect(invoke.mock.calls.filter(([command])=>command==='agent_snapshot')).toHaveLength(2));
});
it.each(['old companion: unrecognized arguments: reported-history','agentsHistoryInvalid'])('keeps old companion/raw failures verbatim with a static manual hint: %s',async raw=>{
  await historyFixture(()=>Promise.reject(raw));render(<AgentPanel sessionId="ssh-one" onUseReportedHistory={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Use reported history'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent',raw);
  expect(screen.getByText(t('agentsHistoryManual'))).toBeTruthy();expect(screen.getByRole('region',{name:'Host companion settings'})).toBeTruthy();
});
it.each(['/path/with spaces/世界.jsonl ',String.raw`C:\Users\owner\Claude.jsonl`,String.raw`\\host\share\Claude.jsonl`,String.raw`\\?\C:\owner\Claude.jsonl`])('admits exact absolute metadata spelling without UI filesystem resolution: %s',path=>{
  expect(parseReportedHistory({...reported,path},'a')).toEqual({...reported,path});
});
it('rejects malformed or mismatched lookup metadata and paths instead of guessing a source',()=>{
  for(const value of [null,{...reported,schemaVersion:2},{...reported,sessionId:'other'},
    {...reported,path:'relative.jsonl'},{...reported,path:'~/history.jsonl'},{...reported,path:'C:relative'},
    {...reported,path:String.raw`\\server`},{...reported,path:'/bad\u0000file'},{...reported,path:'/bad\ud800'},
    {...reported,path:'/'+ '😀'.repeat(1024)},{...reported,reportedAt:'yesterday'},{...reported,paneId:undefined},
    {...reported,status:'missing'},{...reported,status:'ambiguous'},{...reported,status:'unknown'}])expect(()=>parseReportedHistory(value,'a')).toThrow();
});
it.each((['source','access','unmount'] as const).flatMap(transition=>(['success','failure'] as const).map(outcome=>({transition,outcome}))))('drops same-mounted late lookup $outcome after $transition ownership ends',async({transition,outcome})=>{
    let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
    const invoke=await historyFixture(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));const route=vi.fn();
    const view=render(<AgentPanel sessionId="ssh-old" onUseReportedHistory={route}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Use reported history'}));
    await waitFor(()=>expect(invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(1));
    if(transition==='access')await act(async()=>{access(true);access();});
    else if(transition==='source')view.rerender(<AgentPanel sessionId="ssh-new" onUseReportedHistory={route}/>);
    else view.unmount();
    await act(async()=>{if(outcome==='success')finish(reported);else fail('obsolete lookup error');});
    expect(route).not.toHaveBeenCalled();expect(screen.queryByRole('alert')).toBeNull();
    expect(invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(1);
    view.unmount();
});
it('does not let an old lookup settle a newer explicit source lookup',async()=>{
  const pending:((value:unknown)=>void)[]=[];
  const invoke=await historyFixture(()=>new Promise(yes=>pending.push(yes)));const route=vi.fn();
  const view=render(<AgentPanel sessionId="ssh-old" onUseReportedHistory={route}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Use reported history'}));await waitFor(()=>expect(pending).toHaveLength(1));
  view.rerender(<AgentPanel sessionId="ssh-new" onUseReportedHistory={route}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Use reported history'}));await waitFor(()=>expect(pending).toHaveLength(2));
  await act(async()=>{pending[0](reported);});expect(route).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Use reported history'})).toHaveProperty('disabled',true);
  await act(async()=>{pending[1](reported);});await waitFor(()=>expect(route).toHaveBeenCalledTimes(1));
  expect(route.mock.calls[0][0]).toMatchObject({sessionId:'ssh-new',agentSessionId:'a'});
  expect(invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(2);
});
it.each(['en','pt-BR','es'])('keeps reported-history action and fallback localized in %s',async locale=>{
  await historyFixture({schemaVersion:1,status:'missing',sessionId:'a'});
  try {
    await uiI18n.changeLanguage(locale);render(<AgentPanel sessionId="ssh-one" onUseReportedHistory={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button',{name:t('agentsHistoryUse')}));
    await screen.findByText(t('agentsHistoryMissing'));expect(screen.getByText(t('agentsHistoryManual'))).toBeTruthy();
  } finally {await uiI18n.changeLanguage('en');}
});

const discoveryRows=()=>[session,{...session,sessionId:'b',agent:'Codex',project:'/api',state:'working',summary:'Implement parser'},{...session,sessionId:'c',agent:'Gemini',project:'/docs',state:'done',summary:'Published guide'}];
it('searches agent, project and summary locally with matching status counts and explicit clear filters',async()=>{
  const invoke=await historyFixture(reported,discoveryRows());render(<AgentPanel sessionId="discovery"/>);
  await screen.findByText('Implement parser');await act(async()=>{});
  const before=invoke.mock.calls.length;
  const search=screen.getByRole('searchbox',{name:'Search reported agents'});
  const filters=screen.getByRole('group',{name:'Reported status'});
  expect(within(filters).getByRole('button',{name:'All 3'})).toHaveProperty('ariaPressed','true');
  for(const [query,summary] of [['PARSER','Implement parser'],['/docs','Published guide'],['claude','Permission requested']]) {
    fireEvent.change(search,{target:{value:query}});
    expect(screen.getByText(summary)).toBeTruthy();expect(document.querySelectorAll('.agent-card')).toHaveLength(1);
    expect(within(filters).getByRole('button',{name:'All 1'})).toBeTruthy();
  }
  fireEvent.click(within(filters).getByRole('button',{name:'Working 0'}));
  expect(screen.getByText('No matching reported agents')).toBeTruthy();expect(document.querySelectorAll('.agent-card')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));
  expect(search).toHaveProperty('value','');expect(document.querySelectorAll('.agent-card')).toHaveLength(3);
  expect(invoke.mock.calls.length).toBe(before);
});
it('keeps selected reported context, search focus and draft through locale updates, then retires a filtered row',async()=>{
  await historyFixture(reported,discoveryRows());render(<AgentPanel sessionId="selection"/>);
  fireEvent.click(await screen.findByRole('button',{name:'View Claude Code report for /work'}));
  const selected=screen.getByRole('region',{name:'Selected report'});
  fireEvent.click(within(selected).getByText('Report details'));
  expect(within(selected).getByText('%1')).toBeTruthy();expect(within(selected).getByText('a')).toBeTruthy();
  expect(within(selected).queryByRole('button',{name:/jump|attach|approve/i})).toBeNull();
  const search=screen.getByRole('searchbox');fireEvent.change(search,{target:{value:'Permission'}});search.focus();
  try {
    await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
    expect(screen.getByRole('searchbox')).toBe(search);expect(document.activeElement).toBe(search);expect(search).toHaveProperty('value','Permission');
    expect(screen.getByRole('region',{name:'Relato selecionado'})).toBe(selected);
    fireEvent.change(search,{target:{value:'Codex'}});expect(screen.queryByRole('region',{name:'Relato selecionado'})).toBeNull();
    fireEvent.change(search,{target:{value:''}});expect(screen.queryByRole('region',{name:'Relato selecionado'})).toBeNull();
  } finally {await act(async()=>{await uiI18n.changeLanguage('en');});}
});
it('retires selection across host changes while preserving the search draft',async()=>{
  await historyFixture(reported);const view=render(<AgentPanel sessionId="source-a"/>);
  fireEvent.click(await screen.findByRole('button',{name:'View Claude Code report for /work'}));
  const search=screen.getByRole('searchbox');fireEvent.change(search,{target:{value:'Permission'}});search.focus();
  view.rerender(<AgentPanel sessionId="source-b"/>);
  await screen.findByText('Permission requested');
  expect(screen.queryByRole('region',{name:'Selected report'})).toBeNull();
  expect(screen.getByRole('searchbox')).toBe(search);expect(document.activeElement).toBe(search);expect(search).toHaveProperty('value','Permission');
});
it.each(['success','failure'])('retires vanished reports and drops their held history %s without resurrecting selection',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  const rows=[session];const route=vi.fn();
  const invoke=await historyFixture(()=>new Promise((yes,no)=>{finish=yes;fail=no;}),rows);
  render(<AgentPanel sessionId="row-owner" onUseReportedHistory={route}/>);
  fireEvent.click(await screen.findByRole('button',{name:'View Claude Code report for /work'}));
  fireEvent.click(screen.getByRole('button',{name:'Use reported history'}));
  rows.splice(0);fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  await waitFor(()=>expect(document.querySelectorAll('.agent-card')).toHaveLength(0));
  expect(screen.queryByRole('region',{name:'Selected report'})).toBeNull();
  await act(async()=>{if(outcome==='success')finish(reported);else fail('retired row error');});
  expect(route).not.toHaveBeenCalled();expect(screen.queryByText('retired row error')).toBeNull();
  rows.push(session);fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await screen.findByText('Permission requested');
  expect(screen.queryByRole('region',{name:'Selected report'})).toBeNull();
  expect(invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(1);
});
it('hides old reports after refresh failure and preserves the query for explicit retry',async()=>{
  const invoke=await historyFixture(reported);render(<AgentPanel sessionId="failed-refresh"/>);
  fireEvent.click(await screen.findByRole('button',{name:'View Claude Code report for /work'}));
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Permission'}});
  invoke.mockRejectedValueOnce('snapshot unavailable');fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  await screen.findByText('snapshot unavailable');expect(document.querySelectorAll('.agent-card')).toHaveLength(0);
  expect(screen.queryByRole('region',{name:'Selected report'})).toBeNull();expect(screen.getByRole('searchbox')).toHaveProperty('value','Permission');
  fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await screen.findByText('Permission requested');
  expect(screen.queryByRole('region',{name:'Selected report'})).toBeNull();
});
it('refuses ambiguous board selection when reports duplicate the same identity',async()=>{
  await historyFixture(reported,[session,{...session,summary:'duplicate'}]);render(<AgentPanel sessionId="duplicate-board"/>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Invalid agent session.');
  expect(document.querySelectorAll('.agent-card')).toHaveLength(0);
});
it('keeps distinct literal report keys separate',async()=>{
  await historyFixture(reported,[{...session,agent:'a:b',sessionId:'c'},{...session,agent:'a',sessionId:'b:c'}]);render(<AgentPanel sessionId="literal-board"/>);
  fireEvent.click(await screen.findByRole('button',{name:'View a:b report for /work'}));
  expect(within(screen.getByRole('region',{name:'Selected report'})).getByText('c')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'View a report for /work'}));
  expect(within(screen.getByRole('region',{name:'Selected report'})).getByText('b:c')).toBeTruthy();
});
it('keeps the selected identity and focused search draft when explicit refresh updates its report',async()=>{
  const rows=[session];await historyFixture(reported,rows);render(<AgentPanel sessionId="updated-report"/>);
  fireEvent.click(await screen.findByRole('button',{name:'View Claude Code report for /work'}));
  const details=screen.getByRole('region',{name:'Selected report'}),search=screen.getByRole('searchbox');
  fireEvent.change(search,{target:{value:'/work'}});search.focus();
  rows[0]={...session,state:'done',eventCount:9,summary:'Completed permission review'};
  fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  await within(details).findByText('Completed permission review');
  expect(screen.getByRole('region',{name:'Selected report'})).toBe(details);
  expect(within(details).getByText('Done')).toBeTruthy();expect(within(details).getByText('9')).toBeTruthy();
  expect(search).toHaveProperty('value','/work');expect(document.activeElement).toBe(search);
});
it('suspends the same board while preserving its query and settings draft, then explicitly resumes its source',async()=>{
  const invoke=await historyFixture(reported);const view=render(<AgentPanel sessionId="visible-board"/>);
  await screen.findByText('Permission requested');
  const query=screen.getByRole('searchbox');fireEvent.change(query,{target:{value:'/work'}});
  const usage=await screen.findByRole('checkbox',{name:'Recorded usage inspection'});fireEvent.click(usage);
  const before=invoke.mock.calls.length;
  view.rerender(<AgentPanel sessionId="visible-board" visible={false}/>);
  expect(screen.queryByRole('searchbox')).toBeNull();expect(query).toHaveProperty('value','/work');
  expect(invoke.mock.calls.length).toBe(before);
  view.rerender(<AgentPanel sessionId="visible-board"/>);await screen.findByText('Permission requested');
  expect(screen.getByRole('searchbox')).toBe(query);expect(usage).toHaveProperty('checked',false);
  expect(invoke.mock.calls.filter(([command])=>command==='get_companion_settings')).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command])=>command==='agent_snapshot')).toHaveLength(2);
});
it.each(['success','failure'])('retires held history %s when its board becomes hidden',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(reason:unknown)=>void;const route=vi.fn();
  await historyFixture(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));
  const view=render(<AgentPanel sessionId="hidden-history" onUseReportedHistory={route}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Use reported history'}));
  view.rerender(<AgentPanel sessionId="hidden-history" onUseReportedHistory={route} visible={false}/>);
  await act(async()=>{if(outcome==='success')finish(reported);else fail('hidden history failure');});
  view.rerender(<AgentPanel sessionId="hidden-history" onUseReportedHistory={route}/>);await screen.findByText('Permission requested');
  expect(route).not.toHaveBeenCalled();expect(screen.queryByText('hidden history failure')).toBeNull();
});

it('refreshes reported activity only on the foreground visible board without reloading settings',async()=>{
  vi.useFakeTimers();
  const foreground=vi.spyOn(document,'hidden','get').mockReturnValue(false);
  try {
    const rows=[session];const invoke=await historyFixture(reported,rows);
    const snapshots=()=>invoke.mock.calls.filter(([command])=>command==='agent_snapshot').length;
    const view=render(<AgentPanel sessionId="live-board"/>);
    await act(async()=>{});expect(snapshots()).toBe(1);
    rows[0]={...session,state:'working',summary:'New host activity',eventCount:3};
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(screen.getByText('New host activity')).toBeTruthy();expect(snapshots()).toBe(2);
    foreground.mockReturnValue(true);
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(snapshots()).toBe(2);
    foreground.mockReturnValue(false);
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(snapshots()).toBe(3);
    view.rerender(<AgentPanel sessionId="live-board" visible={false}/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(snapshots()).toBe(3);
    view.rerender(<AgentPanel sessionId="live-board"/>);await act(async()=>{});expect(snapshots()).toBe(4);
    expect(invoke.mock.calls.filter(([command])=>command==='get_companion_settings')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(0);
    view.unmount();
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(snapshots()).toBe(4);
    foreground.mockReturnValue(true);
    render(<AgentPanel sessionId="background-board"/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(snapshots()).toBe(4);
  } finally {cleanup();foreground.mockRestore();vi.useRealTimers();}
});

it('coalesces pending snapshots and keeps late old-source completion from unlocking the new source',async()=>{
  vi.useFakeTimers();
  try {
    const {invoke}=await import('@tauri-apps/api/core');
    const pending:((value:unknown)=>void)[]=[];
    vi.mocked(invoke).mockImplementation(command=>command==='agent_snapshot'?new Promise(resolve=>pending.push(resolve)):Promise.resolve({schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true}));
    const view=render(<AgentPanel sessionId="old-pending"/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(pending).toHaveLength(1);
    view.rerender(<AgentPanel sessionId="new-pending"/>);expect(pending).toHaveLength(2);
    await act(async()=>{pending[0]({schemaVersion:1,sessions:[session]});});
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(pending).toHaveLength(2);
    expect(screen.queryByText('Permission requested')).toBeNull();
    await act(async()=>{pending[1]({schemaVersion:1,sessions:[{...session,summary:'Current source report'}]});});
    expect(screen.getByText('Current source report')).toBeTruthy();
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(pending).toHaveLength(3);
  } finally {cleanup();vi.useRealTimers();}
});

it('refreshes a newly installed companion before a held pre-install read can publish its obsolete error',async()=>{
  const {invoke}=await import('@tauri-apps/api/core');let reads=0;
  let finishInstall!:(value:unknown)=>void,rejectOld!:(reason:unknown)=>void;
  vi.mocked(invoke).mockImplementation(command=>{
    if(command==='agent_snapshot'){
      reads++;
      if(reads===1)return Promise.reject({message:'Missing companion'});
      if(reads===2)return new Promise((_resolve,reject)=>{rejectOld=reject;});
      return Promise.resolve({schemaVersion:1,sessions:[session]});
    }
    if(command==='install_companion')return new Promise(resolve=>{finishInstall=resolve;});
    return Promise.resolve({schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true});
  });
  render(<AgentPanel sessionId="install-race"/>);
  fireEvent.click(await screen.findByRole('button',{name:'Install companion'}));
  await screen.findByText('Missing companion');
  fireEvent.click(screen.getByRole('button',{name:'Refresh'}));expect(reads).toBe(2);
  await act(async()=>{finishInstall({schemaVersion:1,status:'installed',version:'1.0.0',path:'/owned/agent',cleanup:'complete'});});
  expect(await screen.findByText('Permission requested')).toBeTruthy();expect(reads).toBe(3);
  await act(async()=>{rejectOld({message:'Obsolete companion failure'});});
  expect(screen.queryByText('Obsolete companion failure')).toBeNull();
});

it('keeps the companion empty state stable during polling and retains an error until a replacement read completes',()=>pollingClock(async invoke=>{
    let pending!:ReturnType<typeof deferredRead>;
    let reads=0;
    vi.mocked(invoke).mockImplementation(command=>{
      if(command==='agent_snapshot')return ++reads===1?Promise.resolve({schemaVersion:1,sessions:[]}):(pending=deferredRead()).promise;
      if(command==='multiplexer_sessions')return Promise.resolve([]);
      return Promise.resolve({schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true});
    });
    render(<AgentPanel sessionId="stable-reports"/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
    const region=screen.getByRole('region',{name:t('agentsTitle')}),panel=within(region);
    const empty=panel.getByRole('heading',{name:t('agentsEmpty')}),count=panel.getByText(t('agentsResultCount',{shown:'0',total:'0'}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(panel.getByRole('heading',{name:t('agentsEmpty')})).toBe(empty);
    expect(panel.getByText(t('agentsResultCount',{shown:'0',total:'0'}))).toBe(count);
    expect(panel.queryByText(t('agentsReading'))).toBeNull();
    const refresh=panel.getByRole('button',{name:t('agentsRefresh')});
    expect(refresh).toHaveProperty('disabled',true);expect(refresh.getAttribute('aria-busy')).toBe('true');
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(reads).toBe(2);
    await act(async()=>pending.reject(new Error('Owned report read unavailable')));
    const failure=panel.getByText('Owned report read unavailable');
    expect(panel.queryByRole('heading',{name:t('agentsEmpty')})).toBeNull();
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(panel.getByText('Owned report read unavailable')).toBe(failure);
    expect(panel.queryByRole('heading',{name:t('agentsEmpty')})).toBeNull();expect(panel.queryByText(t('agentsReading'))).toBeNull();
    await act(async()=>pending.resolve({schemaVersion:1,sessions:[session]}));
    expect(panel.queryByText('Owned report read unavailable')).toBeNull();expect(panel.getByText('Permission requested')).toBeTruthy();
    expect(refresh.getAttribute('aria-busy')).toBe('false');
}));

describe('live Herdr discovery',()=>{
  const tree={workspaces:[{workspace_id:'w1',label:'Work',focused:true,agent_status:'working'}],tabs:[{tab_id:'w1:t1',workspace_id:'w1',label:'Code',number:1,focused:true,agent_status:'working'}],panes:[{pane_id:'w1:p1',workspace_id:'w1',tab_id:'w1:t1',cwd:'/work/codex',focused:true,agent_status:'working'}],agents:[{terminal_id:'term-one',name:'builder',agent:'codex',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',agent_status:'working'}]};
  it.each([{name:'no servers',servers:[]},{name:'server choice',servers:[{name:'first'},{name:'second'}]}])('keeps $name steady while its server list refreshes',({servers})=>pollingClock(async invoke=>{
      let pending!:ReturnType<typeof deferredRead>,calls=0;
      vi.mocked(invoke).mockImplementation(()=>++calls===1?Promise.resolve(servers):(pending=deferredRead()).promise);
      render(<HerdrAgentsPanel sessionId="stable-servers" visible/>);
      await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
      const live=within(screen.getByRole('region',{name:'Live Herdr agents'}));
      const content=()=>servers.length?live.getByRole('combobox',{name:t('herdrAgentsServer')}):live.getByText(t('herdrAgentsNoServers'));
      const settled=content();
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(content()).toBe(settled);expect(live.queryByText(t('herdrReading'))).toBeNull();
      await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(calls).toBe(2);
      await act(async()=>pending.resolve(servers));expect(content()).toBe(settled);
      expect(vi.mocked(invoke).mock.calls.every(([command])=>command==='multiplexer_sessions')).toBe(true);
  }));
  it('keeps live rows, counts and search stable while polling and retains a failed read until its replacement settles',()=>pollingClock(async invoke=>{
      let pending!:ReturnType<typeof deferredRead>;
      let reads=0;
      vi.mocked(invoke).mockImplementation(command=>command==='multiplexer_sessions'?Promise.resolve([{name:'default'}]):
        ++reads===1?Promise.resolve(tree):(pending=deferredRead()).promise);
      render(<HerdrAgentsPanel sessionId="stable-live" visible/>);
      await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
      const region=screen.getByRole('region',{name:'Live Herdr agents'}),live=within(region);
      const card=live.getByText('builder'),count=live.getByText(t('herdrAgentsCount',{shown:'1',total:'1'}));
      const search=live.getByRole('searchbox');fireEvent.change(search,{target:{value:'codex'}});
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(live.getByText('builder')).toBe(card);
      expect(live.getByText(t('herdrAgentsCount',{shown:'1',total:'1'}))).toBe(count);
      expect(region.getAttribute('aria-busy')).toBe('true');
      expect(live.queryByText(t('herdrReading'))).toBeNull();expect(search).toHaveProperty('value','codex');
      expect(live.getByRole('button',{name:t('herdrAgentsRefresh')})).toHaveProperty('disabled',true);
      await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(reads).toBe(2);
      await act(async()=>pending.reject(new Error('Owned live read unavailable')));
      const failure=live.getByText(/Owned live read unavailable/);
      expect(live.queryByText('builder')).toBeNull();expect(live.queryByText(/Showing .*detected agents/)).toBeNull();
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(live.getByText(/Owned live read unavailable/)).toBe(failure);
      expect(live.queryByText(t('herdrReading'))).toBeNull();expect(live.queryByText(/Showing .*detected agents/)).toBeNull();
      await act(async()=>pending.resolve({...tree,agents:[]}));
      expect(live.queryByText(/Owned live read unavailable/)).toBeNull();
      expect(live.getByText(t('herdrAgentsCount',{shown:'0',total:'0'}))).toBeTruthy();
      expect(live.getByRole('searchbox')).toBe(search);expect(search).toHaveProperty('value','codex');
      expect(region.getAttribute('aria-busy')).toBe('false');
  }));
  it.each(['missing','empty'])('shows Herdr Codex when companion reports are %s',async companion=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async command=>{
      if(command==='multiplexer_sessions')return [{name:'default'}];
      if(command==='herdr_tree')return tree;
      if(command==='agent_snapshot'){if(companion==='missing')throw new Error('companion missing');return {schemaVersion:1,sessions:[]};}
      return {schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
    });
    render(<AgentPanel sessionId="codex-host"/>);
    expect(await screen.findByText('builder')).toBeTruthy();
    const live=screen.getByRole('region',{name:'Live Herdr agents'});
    expect(within(live).getByText('codex')).toBeTruthy();expect(within(live).getByText('/work/codex')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('herdr_tree',{sessionId:'codex-host',name:'default'},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
    expect(within(live).queryByRole('button',{name:/approve|send|history/i})).toBeNull();
  });
  it('projects only live agent metadata and rejects malformed, duplicate or unmatched rows',()=>{
    const secret={...tree.agents[0],tokens:{secret:'must-not-leak'},agent_session:{transcript:'private'}};
    expect(parseHerdrAgents({...tree,agents:[secret]})[0]).toEqual({...tree.agents[0],cwd:'/work/codex'});
    expect(()=>parseHerdrAgents({...tree,agents:undefined})).toThrow(t('herdrAgentsUnsupported'));
    expect(parseHerdrAgents({...tree,agents:[]})).toEqual([]);
    expect(parseHerdrAgents({...tree,panes:[{...tree.panes[0],cwd:null}]})[0].cwd).toBeNull();
    for(const value of [null,{...tree,agents:{}},{...tree,agents:[tree.agents[0],tree.agents[0]]},
      {...tree,agents:[{...tree.agents[0],agent_status:'approved'}]},
      {...tree,agents:[{...tree.agents[0],pane_id:'w2:p1'}]},
      {...tree,agents:[{...tree.agents[0],terminal_id:''}]},
      {...tree,panes:[{...tree.panes[0],cwd:'/bad\u0000path'}]},
      {...tree,agents:Array(4097).fill(tree.agents[0])}])expect(()=>parseHerdrAgents(value)).toThrow();
  });
  it('requires a server choice for multiple servers and never mixes same-pane agents across them',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async(command,args)=>{
      if(command==='multiplexer_sessions')return [{name:'first'},{name:'second'}];
      if(command==='herdr_tree')return {...tree,agents:[{...tree.agents[0],name:`builder-${(args as {name:string}).name}`,agent_status:'idle'}]};
      throw new Error('Unexpected live Herdr request');
    });
    render(<HerdrAgentsPanel sessionId="multi-host" visible/>);
    const select=await screen.findByRole('combobox',{name:'Herdr server'});
    expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='herdr_tree')).toHaveLength(0);
    fireEvent.change(select,{target:{value:'second'}});
    await screen.findByText('builder-second');expect(screen.getByText('Idle')).toBeTruthy();
    await waitFor(()=>expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select,{target:{value:'first'}});
    await screen.findByText('builder-first');expect(screen.queryByText('builder-second')).toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='herdr_tree').map(([,args])=>(args as {name:string}).name)).toEqual(['second','first']);
  });
  it('distinguishes missing live metadata from a genuinely empty server',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(command=>Promise.resolve(command==='multiplexer_sessions'?[{name:'default'}]:{...tree,agents:undefined}));
    render(<HerdrAgentsPanel sessionId="legacy-host" visible onRestoreHostTools={vi.fn()}/>);
    await screen.findByText(`${t('herdrAgentsUnavailable')} ${t('herdrAgentsUnsupported')}`);
    expect(screen.queryByText(/Showing .*detected agents/)).toBeNull();
    expect(screen.queryByText('builder')).toBeNull();
    expect(screen.queryByRole('button',{name:t('hostToolsRestore')})).toBeNull();
  });
  it.each([
    {name:'closed command control',error:{kind:'ssh_host_tools_closed',message:'same host error text'},recover:true},
    {name:'closed upload control',error:{kind:'ssh_control_closed',message:'same host error text'},recover:false},
    {name:'remote command',error:{kind:'remote_command_failed',message:'same host error text'},recover:false},
    {name:'text-only error',error:new Error('same host error text'),recover:false},
  ])('offers explicit recovery only for $name',async({error,recover})=>{
    const {invoke}=await import('@tauri-apps/api/core'),restore=vi.fn();
    vi.mocked(invoke).mockImplementation(async command=>{if(command==='multiplexer_sessions')return [{name:'default'}];throw error;});
    render(<HerdrAgentsPanel sessionId="control-owner" visible onRestoreHostTools={restore}/>);
    await screen.findByText(`${t('herdrAgentsUnavailable')} ${recover?t('hostToolsClosed'):'same host error text'}`);
    const button=screen.queryByRole('button',{name:t('hostToolsRestore')});
    expect(!!button).toBe(recover);expect(restore).not.toHaveBeenCalled();
    if(button){
      fireEvent.click(button);expect(restore).toHaveBeenCalledOnce();
      vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_sessions'?[{name:'default'}]:tree);
      await act(async()=>restore.mock.calls[0][0]());
      await screen.findByText('builder');
      expect(screen.queryByRole('button',{name:t('hostToolsRestore')})).toBeNull();
    }
  });
  it('suspends discovery when hidden and drops an old source before issuing its snapshot',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    let complete!:(value:unknown)=>void;
    vi.mocked(invoke).mockImplementation(command=>command==='multiplexer_sessions'?new Promise(resolve=>{complete=resolve;}):Promise.resolve(tree));
    const view=render(<HerdrAgentsPanel sessionId="old-host" visible={false}/>);
    expect(invoke).not.toHaveBeenCalled();
    view.rerender(<HerdrAgentsPanel sessionId="old-host" visible/>);
    await waitFor(()=>expect(complete).toBeTypeOf('function'));
    view.rerender(<HerdrAgentsPanel sessionId="new-host" visible={false}/>);
    await act(async()=>complete([{name:'default'}]));
    expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='herdr_tree')).toHaveLength(0);
    expect(screen.queryByText('builder')).toBeNull();
  });
  it('does not overlap periodic discovery while a server snapshot remains pending',async()=>{
    vi.useFakeTimers();
    try {
      const {invoke}=await import('@tauri-apps/api/core');
      let complete!:(value:unknown)=>void;
      vi.mocked(invoke).mockImplementation(command=>command==='multiplexer_sessions'?Promise.resolve([{name:'default'}]):new Promise(resolve=>{complete=resolve;}));
      render(<HerdrAgentsPanel sessionId="bounded-host" visible/>);
      await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
      expect(vi.mocked(invoke).mock.calls.map(([name])=>name)).toEqual(['multiplexer_sessions','herdr_tree']);
      await act(async()=>complete(tree));expect(screen.getByText('builder')).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
      expect(vi.mocked(invoke).mock.calls.map(([name])=>name)).toEqual(['multiplexer_sessions','herdr_tree','multiplexer_sessions','herdr_tree']);
    } finally {cleanup();vi.useRealTimers();}
  });

  it('starts the current discovery immediately after StrictMode replaces its first pending owner',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_sessions'?[{name:'default'}]:tree);
    render(<StrictMode><HerdrAgentsPanel sessionId="strict-host" visible/></StrictMode>);
    expect(await screen.findByText('builder')).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='herdr_tree')).toHaveLength(1);
  });

  it.each(['en','pt-BR','es'])('localizes live discovery and preserves unknown status in %s',async locale=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_sessions'?[{name:'default'}]:{...tree,agents:[{...tree.agents[0],agent_status:'unknown'}]});
    try {
      await uiI18n.changeLanguage(locale);render(<HerdrAgentsPanel sessionId="localized-host" visible/>);
      await screen.findByText('builder');
      expect(screen.getByRole('region',{name:t('herdrAgentsTitle')})).toBeTruthy();
      expect(screen.getByText(t('herdrAgentUnknown'))).toBeTruthy();
      expect(screen.getByRole('combobox',{name:t('herdrAgentsServer')})).toBeTruthy();
    } finally {await uiI18n.changeLanguage('en');}
  });

  it('keeps server selection usable after a failed server read and removes its old live rows',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async(command,args)=>{
      if(command==='multiplexer_sessions')return [{name:'offline'},{name:'online'}];
      if((args as {name:string}).name==='offline')throw new Error('Owned server unavailable');
      return tree;
    });
    render(<HerdrAgentsPanel sessionId="recover-host" visible/>);
    const picker=await screen.findByRole('combobox',{name:'Herdr server'});
    fireEvent.change(picker,{target:{value:'online'}});await screen.findByText('builder');
    await waitFor(()=>expect((picker as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(picker,{target:{value:'offline'}});await screen.findByText(/Owned server unavailable/);
    expect(screen.queryByText('builder')).toBeNull();
    fireEvent.change(picker,{target:{value:'online'}});await screen.findByText('builder');
  });

  it('does not publish live metadata or issue the next RPC after app access changes',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    let complete!:(value:unknown)=>void;
    vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    render(<HerdrAgentsPanel sessionId="locked-host" visible/>);
    await waitFor(()=>expect(complete).toBeTypeOf('function'));
    await act(async()=>{access(true);complete([{name:'default'}]);});
    expect(screen.queryByText('builder')).toBeNull();
    expect(vi.mocked(invoke).mock.calls.map(([name])=>name)).toEqual(['multiplexer_sessions']);
  });

});
