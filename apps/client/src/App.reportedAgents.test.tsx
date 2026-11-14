// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {chooseWorkspaceTool, connectForNavigation, generationBase, mocks, openConnection, reportedAgent, reportedAppMetadata, reportedHistoryApp, unlockedStatus} from './test/appHarness';
import {t} from './i18n/core';
import {expect, it, vi} from "vitest";
import {act, screen, waitFor, within} from "@testing-library/react";
import {herdrNavigationTree} from './test/herdrNavigation';
import {topBarKey} from './sideMenuMode';

it.each(['success','failure','same-snapshot-failure','server','mode','viewport','lock','session','same-mode','inbox-entry','jump-live','double-back'] as const)('restores only a fresh same-owner mobile Agents read: %s',async outcome=>{
  const media={matches:false,addEventListener:vi.fn<(event:string,callback:(event:{matches:boolean})=>void)=>void>(),removeEventListener:vi.fn()};
  vi.stubGlobal('matchMedia',vi.fn(()=>media));
  // This test drives the narrow header's Workspace tools sheet; the side menu has its own coverage.
  vi.mocked(localStorage.getItem).mockImplementation(key=>key===topBarKey?'true':null);
  let finish!:(value:unknown)=>void,fail!:(reason:Error)=>void,reads=0;
  const reported={...herdrNavigationTree,agents:herdrNavigationTree.agents as typeof herdrNavigationTree.agents|undefined};
  const original=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,args)=>{
    if(command==='multiplexer_sessions')return Promise.resolve([{name:outcome==='server' && reads>0?'replacement':'default'}]);
    if(command==='herdr_tree')return ++reads===1?Promise.resolve(reported):new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
    return original(command,args);
  });
  const user=await connectForNavigation('scroll-origin');
  const resize=(matches:boolean)=>act(()=>{media.matches=matches;for(const [event,callback] of media.addEventListener.mock.calls)if(event==='change')callback({matches});});
  resize(true);await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  await user.click(within(screen.getByRole('dialog',{name:'Workspace tools'})).getByRole('button',{name:'Agents'}));await screen.findByRole('button',{name:/^builder/});
  const scroller=document.querySelector<HTMLDivElement>('.workspace-navigation-scroll')!;scroller.scrollTop=731;
  await user.click(screen.getByRole('button',{name:'Open usage from navigation'}));scroller.scrollTop=0;
  if(outcome==='viewport')resize(false);
  if(outcome==='lock')await act(async()=>mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined}}));
  if(outcome==='session'){
    mocks.api.connect.mockResolvedValue({sessionId:'other-scroll-source'});
    await user.click(screen.getByRole('button',{name:t('navigationConnections')}));
    await user.click(screen.getByRole('button',{name:'Connect to Home'}));await user.type(screen.getByLabelText('Password'),'owned');await user.click(screen.getByRole('button',{name:'Connect'}));
  }
  if(outcome==='mode'){
    await user.click(screen.getByRole('button',{name:t('navigationWorkspaces')}));
  }else if(outcome!=='lock' && outcome!=='session')await user.click(screen.getByRole('button',{name:'Back'}));
  if(outcome==='lock'||outcome==='session'){expect(scroller.scrollTop).toBe(0);return;}
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(outcome==='same-mode')await user.click(screen.getByRole('button',{name:t('navigationAgents')}));
  if(outcome==='inbox-entry')act(()=>window.dispatchEvent(new CustomEvent('lazysh-inbox-open',{detail:{sessionId:'scroll-origin'}})));
  if(outcome==='jump-live')await user.click(within(screen.getByRole('navigation',{name:t('agentsSections')})).getByRole('button',{name:t('herdrAgentsTitle')}));
  if(outcome==='double-back')act(()=>mocks.backButton?.({canGoBack:false}));
  expect(scroller.scrollTop).toBe(0); // The retained old receipt cannot restore while a fresh read is held.
  if(outcome==='failure')await act(async()=>fail(new Error('Owned fresh read failed')));
  else if(outcome==='same-snapshot-failure')await act(async()=>{reported.agents=undefined;finish(reported);});
  else await act(async()=>finish({...herdrNavigationTree}));
  expect(scroller.scrollTop).toBe(outcome==='success'?731:0);
  if(outcome==='failure'||outcome==='same-snapshot-failure'){
    await user.click(screen.getByRole('button',{name:t('herdrRefresh')}));await act(async()=>finish({...herdrNavigationTree}));expect(scroller.scrollTop).toBe(0);
  }
  expect(mocks.api.write).not.toHaveBeenCalled();expect(mocks.api.disconnect).not.toHaveBeenCalled();
});

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
  mark('open-agents');await chooseWorkspaceTool(user,'Agents');await user.click(screen.getByRole('button',{name:'Reported agent activity'}));
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
  mark('return-terminal');await chooseWorkspaceTool(user,'Terminal');
  mark('wait-terminal');await screen.findByText('Live SSH terminal');
  mark('return-transcript');await chooseWorkspaceTool(user,'Transcript');
  mark('wait-retired-path');expect(await screen.findByLabelText('Transcript path')).toHaveProperty('value','');
  mark('assert-retired-notice');expect(screen.queryByText(t('agentsHistoryNotice'))).toBeNull();
});

it.each((['connections','live','live-return','live-batched-return','live-before-commit'] as const).flatMap(transition=>(['success','failure'] as const).map(outcome=>({transition,outcome}))))('prevents a pending actual Agent lookup $outcome from reopening Chat after $transition navigation',async({transition,outcome})=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  reportedHistoryApp(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));mocks.api.connect.mockResolvedValue({sessionId:'ssh-reported-app'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  await chooseWorkspaceTool(user,'Agents');await user.click(screen.getByRole('button',{name:'Reported agent activity'}));await user.click(await screen.findByRole('button',{name:'Use reported history'}));
  const settle=()=>{if(outcome==='success')finish(reportedAppMetadata);else fail('old reported route error');};
  if(transition==='live-before-commit')await act(async()=>{screen.getByRole('button',{name:'Live Herdr agents'}).click();settle();});
  else{
    await user.click(screen.getByRole('button',{name:transition==='connections'?'Connections':'Live Herdr agents'}));await screen.findByText('Live SSH terminal');
    if(transition==='live-return')await user.click(screen.getByRole('button',{name:'Reported agent activity'}));
    if(transition==='live-batched-return')await act(async()=>{screen.getByRole('button',{name:'Reported agent activity'}).click();screen.getByRole('button',{name:'Live Herdr agents'}).click();});
    await act(async()=>settle());
  }
  expect(screen.getByText('Live SSH terminal')).toBeTruthy();
  expect(screen.queryByLabelText('Transcript path')).toBeNull();expect(screen.queryByText('old reported route error')).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='agent_reported_history')).toHaveLength(1);
});
