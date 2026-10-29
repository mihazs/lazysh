// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentPanel, parseReportedHistory, parseSnapshot,type ReportedHistorySource } from './AgentPanel';
import {applyAccessStatus} from './access';
import {t,uiI18n} from './i18n/core';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn()}));
vi.mock('./ApprovalPanel', () => ({default: () => null}));
const session = { sessionId: 'a', agent: 'Claude Code', project: '/work', state: 'needs_attention', updatedAt: '2026-10-24T19:30:00Z', summary: 'Permission requested', paneId: '%1', eventCount: 2 };
let generation=0;
function access(locked=false) {
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked,generation:String(++generation),...(locked?{}:{nonce:'a'.repeat(64)})});
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
