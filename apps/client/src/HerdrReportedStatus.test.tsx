// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {parseSnapshot} from './AgentPanel';
import {applyAccessStatus,captureAccess} from './access';
import {withReportedStatus,type ReportedSessionSource} from './HerdrSessionDetails';
import HerdrNavigation from './HerdrNavigation';
import {parseHerdrAgents,type HerdrTree} from './useHerdrNavigation';

vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

// Identity and status recorded from stock Herdr 0.9.3: a `codex` process at an idle
// prompt is Unknown, and Herdr's own Codex integration reported its session ID.
const herdr:HerdrTree={
  workspaces:[{workspace_id:'w1',label:'codex',focused:true,agent_status:'unknown'}],
  tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'1',number:1,focused:true,agent_status:'unknown'}],
  panes:[{workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',terminal_id:'term_65f807c293ced1',cwd:'/work/codex',focused:true,agent_status:'unknown'}],
  agents:[{terminal_id:'term_65f807c293ced1',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',agent_status:'unknown',agent:'codex',name:null,
    agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'lazysh-owned-990'}}],
};
// `lazysh-agent snapshot` after Codex UserPromptSubmit and PermissionRequest hooks
// for that session, plus an unrelated finished session.
const companion={schemaVersion:1,sessions:[
  {agent:'Codex',eventCount:1,paneId:null,project:'/work/other',sessionId:'lazysh-owned-991',state:'done',summary:'Turn finished',updatedAt:'2026-11-05T05:13:05.583116Z'},
  {agent:'Codex',eventCount:2,paneId:null,project:'/work/codex',sessionId:'lazysh-owned-990',state:'needs_attention',summary:'Bash',updatedAt:'2026-11-05T05:13:05.571815Z'},
]};
const reports=(change:Partial<ReportedSessionSource>={}):ReportedSessionSource=>({host:'host',available:true,rows:parseSnapshot(companion),lease:captureAccess(),...change});
const view=(tree:HerdrTree=herdr)=>({rows:parseHerdrAgents(tree),snapshot:tree});
const second={...herdr.agents![0],terminal_id:'term-second',pane_id:'w1:p2'};
const shared:HerdrTree={...herdr,panes:[...herdr.panes,{...herdr.panes[0],pane_id:second.pane_id,terminal_id:second.terminal_id}],agents:[herdr.agents![0],second]};

let revision=0;
const unlocked=()=>applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++revision),nonce:'b'.repeat(64)});
const lock=()=>applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(++revision)});
beforeEach(unlocked);
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('Herdr live agent status from exact event context',()=>{
  it.each([['working','working'],['needs_attention','blocked'],['done','done']] as const)('maps an exact %s companion report onto an Unknown Herdr pane',(state,status)=>{
    const source=reports({rows:parseSnapshot({...companion,sessions:companion.sessions.map(row=>row.sessionId==='lazysh-owned-990'?{...row,state}:row)})});
    const result=withReportedStatus(view(),source,'host');
    expect(result.rows[0]).toMatchObject({agent_status:status,status_source:'report',pane_id:'w1:p1'});
    expect(result.snapshot?.panes[0].agent_status).toBe(status);
    // Workspace and tab aggregates stay Herdr's own.
    expect(result.snapshot?.workspaces[0].agent_status).toBe('unknown');
  });
  it('keeps every state Herdr itself reports',()=>{
    for(const agent_status of ['working','blocked','idle','done'] as const) {
      const data=view({...herdr,agents:[{...herdr.agents![0],agent_status}]});
      expect(withReportedStatus(data,reports(),'host')).toBe(data);
    }
  });
  it('stays Unknown without one exact readable match',()=>{
    const cases:[ReturnType<typeof view>,ReportedSessionSource|undefined][]=[
      [view(),undefined],
      [view(),reports({available:false})],
      [view(),reports({host:'other-host'})],
      [view(),reports({rows:[]})],
      [view(),reports({rows:[...reports().rows,...reports().rows]})],
      [view(),reports({rows:reports().rows.map(row=>({...row,agent:'Claude Code'}))})],
      [view({...herdr,agents:[{...herdr.agents![0],agent_session:undefined}]}),reports()],
      [view(shared),reports()],
    ];
    for(const [data,source] of cases)expect(withReportedStatus(data,source,'host')).toBe(data);
    const data=view(),source=reports();
    lock();
    expect(withReportedStatus(data,source,'host')).toBe(data);
  });
  it('groups and labels the derived state in live Agents and Spaces',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_sessions'?[{name:'default'}]:herdr);
    const props={sessionId:'host',hostLabel:'Owned host',visible:true,reports:reports(),onNavigate:vi.fn(),onAttach:vi.fn(),onClose:vi.fn()};
    const {rerender}=render(<HerdrNavigation {...props} mode="agents"/>);
    const group=await screen.findByRole('region',{name:'Needs attention'});
    expect(within(group).getByText('codex')).toBeTruthy();
    expect(screen.queryByRole('region',{name:'Unknown status'})).toBeNull();
    rerender(<HerdrNavigation {...props} mode="spaces"/>);
    expect(document.querySelector('.herdr-navigation-row[data-agent-status="blocked"]')?.textContent).toContain('codex');
    rerender(<HerdrNavigation {...props} reports={reports({rows:[]})} mode="agents"/>);
    expect(await screen.findByRole('region',{name:'Unknown status'})).toBeTruthy();
  });
});
