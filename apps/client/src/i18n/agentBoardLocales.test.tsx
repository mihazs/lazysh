// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AgentPanel from '../AgentPanel';
import ApprovalPanel from '../ApprovalPanel';
import CompanionSettingsPanel from '../CompanionSettingsPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {agentApproval,agentBoardRecord,agentBoardSession,companionSettings,inactiveBoardDisplay} from '../test/agentBoardData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic agent locale authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);localStorage.clear();
});
afterEach(async()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.clearAllMocks();await uiI18n.changeLanguage('en');});
async function languagesKeep(check:()=>void){const calls=[...vi.mocked(invoke).mock.calls];for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);}}
it('preserves reported rows, unsaved switches and all child ownership while translating the complete board',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_snapshot'?{schemaVersion:1,sessions:[agentBoardRecord]}:command==='agent_approvals'?{schemaVersion:1,requests:[]}:command==='get_companion_settings'?companionSettings:inactiveBoardDisplay);
  const view=render(<AgentPanel sessionId={agentBoardSession}/>);
  await screen.findByText(agentBoardRecord.summary);const usage=await screen.findByLabelText(t('companionUsage'));fireEvent.click(usage);usage.focus();
  const card=view.container.querySelector('.agent-card');const keepAwake=screen.getByRole('region',{name:t('keepAwakeRegion')});
  await languagesKeep(()=>{
    expect(screen.getByLabelText(t('companionUsage'))).toBe(usage);expect(usage).toHaveProperty('checked',false);expect(document.activeElement).toBe(usage);
    expect(view.container.querySelector('.agent-card')).toBe(card);expect(screen.getByText(agentBoardRecord.summary)).toBeTruthy();expect(screen.getByRole('region',{name:t('agentsNeedsYou')})).toBeTruthy();
    expect(screen.getByRole('region',{name:t('keepAwakeRegion')})).toBe(keepAwake);expect(card?.querySelector('time')?.getAttribute('datetime')).toBe(agentBoardRecord.updatedAt);
  });
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='update_companion_settings')).toBe(false);
  expect(view.container.textContent).not.toContain('c'.repeat(64));expect(view.container.querySelector('img,script')).toBeNull();
});
it.each(['allow','deny'] as const)('binds one held %s decision to its original hash/session/pane',async decision=>{
  const request=agentApproval();let complete!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[request]}:new Promise(resolve=>{complete=resolve;}));
  render(<ApprovalPanel sessionId={agentBoardSession}/>);await screen.findByRole('button',{name:t('approvalsAllow')});vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button',{name:t(decision==='allow'?'approvalsAllow':'approvalsDeny')}));
  const article=screen.getByRole('article');const input=article.querySelector('pre');
  await languagesKeep(()=>{expect(screen.getByRole('article')).toBe(article);expect(input?.textContent).toBe(JSON.stringify(request.toolInput,null,2));expect(screen.getByRole('button',{name:t('approvalsAllow')})).toHaveProperty('disabled',true);fireEvent.click(screen.getByRole('button',{name:t('approvalsDeny')}));});
  expect(invoke).toHaveBeenLastCalledWith('resolve_agent_approval',{sessionId:agentBoardSession,id:request.id,expectedHash:request.expectedHash,agentSessionId:request.sessionId,paneId:request.paneId,decision},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});
  expect(article.textContent).not.toContain(request.expectedHash);expect(article.textContent).not.toContain('c'.repeat(64));
  await act(async()=>{complete({schemaVersion:1,accepted:true});});expect(screen.queryByRole('article')).toBeNull();
});
it('keeps the original polling interval and skips dispatch while a decision is in flight',async()=>{
  vi.useFakeTimers();
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  const timer=vi.spyOn(window,'setInterval');const clear=vi.spyOn(window,'clearInterval');
  let complete!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[agentApproval()]}:new Promise(resolve=>{complete=resolve;}));
  const view=render(<ApprovalPanel sessionId={agentBoardSession}/>);
  await act(async()=>{});expect(timer).toHaveBeenCalledTimes(1);expect(timer.mock.calls[0][1]).toBe(10000);
  await languagesKeep(()=>expect(screen.getByRole('article')).toBeTruthy());
  expect(timer).toHaveBeenCalledTimes(1);expect(clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:t('approvalsAllow')}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='agent_approvals')).toHaveLength(1);
  await act(async()=>{complete({schemaVersion:1,accepted:true});});
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='agent_approvals')).toHaveLength(2);
  view.unmount();expect(clear).toHaveBeenCalledTimes(1);
  delete (document as unknown as {hidden?:boolean}).hidden;
});
it('keeps host rejection visible and translated without retrying or treating it as accepted',async()=>{
  const request=agentApproval();vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[request]}:{schemaVersion:1,accepted:false});
  render(<ApprovalPanel sessionId={agentBoardSession}/>);fireEvent.click(await screen.findByRole('button',{name:t('approvalsAllow')}));await screen.findByText(t('approvalsNotAccepted'));vi.useFakeTimers();
  await languagesKeep(()=>{expect(screen.getByText(t('approvalsNotAccepted'))).toBeTruthy();expect(screen.getByRole('article')).toBeTruthy();});
});
it('does not retarget a held decision or let its result remove the next session request',async()=>{
  const request=agentApproval();let complete!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[request]}:new Promise(resolve=>{complete=resolve;}));
  const view=render(<ApprovalPanel sessionId="old-session"/>);fireEvent.click(await screen.findByRole('button',{name:t('approvalsAllow')}));
  view.rerender(<ApprovalPanel sessionId="new-session"/>);await screen.findByRole('button',{name:t('approvalsAllow')});vi.useFakeTimers();
  await languagesKeep(()=>expect(screen.getByRole('article')).toBeTruthy());await act(async()=>{complete({schemaVersion:1,accepted:true});});expect(screen.getByRole('article')).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='resolve_agent_approval')).toHaveLength(1);expect(vi.mocked(invoke).mock.calls.find(([command])=>command==='resolve_agent_approval')![1]).toMatchObject({sessionId:'old-session',expectedHash:request.expectedHash});
});
it('leaves expired decisions disabled in every interface language',async()=>{
  vi.mocked(invoke).mockResolvedValue({schemaVersion:1,requests:[agentApproval(new Date(Date.now()-1000).toISOString())]});render(<ApprovalPanel sessionId={agentBoardSession}/>);await screen.findByRole('article');vi.useFakeTimers();
  await languagesKeep(()=>{for(const key of ['approvalsAllow','approvalsDeny'] as const){expect(screen.getByRole('button',{name:t(key)})).toHaveProperty('disabled',true);fireEvent.click(screen.getByRole('button',{name:t(key)}));}});
});
it('retains the exact settings revision/booleans through held save and translates its local refresh warning around raw host text',async()=>{
  let reject!:(reason:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='get_companion_settings'?companionSettings:new Promise((_,no)=>{reject=no;}));
  render(<CompanionSettingsPanel sessionId={agentBoardSession}/>);fireEvent.click(await screen.findByLabelText(t('companionDevices')));fireEvent.click(screen.getByRole('button',{name:t('companionSave')}));
  await languagesKeep(()=>{expect(screen.getByRole('status').textContent).toBe(t('companionBusy'));expect(screen.getByLabelText(t('companionDevices'))).toHaveProperty('checked',false);});
  expect(invoke).toHaveBeenLastCalledWith('update_companion_settings',{sessionId:agentBoardSession,settings:{expectedRevision:7,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:false}},{headers:{'X-Lazysh-Access':'c'.repeat(64)}});
  const raw='companionUnsupported <native/user/path> {{error}}';await act(async()=>{reject({key:'companionUnsupported',message:raw});});
  await languagesKeep(()=>{expect(screen.getByRole('alert').textContent).toBe(t('companionRefreshWarning',{error:raw}));expect(screen.getByLabelText(t('companionDevices'))).toHaveProperty('checked',false);expect(screen.queryByText(t('companionSaved'))).toBeNull();});
});
it.each([
  {command:'agent_snapshot',key:'agentsUnsupportedSnapshot',value:null},
  {command:'agent_snapshot',key:'agentsInvalidSession',value:{schemaVersion:1,sessions:[{}]}},
  {command:'agent_approvals',key:'approvalsUnsupported',value:null},
  {command:'agent_approvals',key:'approvalsInvalid',value:{schemaVersion:1,requests:[null]}},
  {command:'agent_approvals',key:'approvalsInvalidContext',value:{schemaVersion:1,requests:[{}]}},
  {command:'agent_approvals',key:'approvalsInvalidIdentity',value:{schemaVersion:1,requests:[{...agentApproval(),expectedHash:'bad'}]}},
  {command:'get_companion_settings',key:'companionUnsupported',value:null},
] as const)('retranslates already-visible $key while preserving parser and raw DOM boundaries',async scenario=>{
  vi.mocked(invoke).mockImplementation(async command=>command===scenario.command?scenario.value:command==='agent_approvals'?{schemaVersion:1,requests:[]}:inactiveBoardDisplay);
  const panel=scenario.command==='agent_snapshot'?<AgentPanel sessionId={agentBoardSession}/>:scenario.command==='agent_approvals'?<ApprovalPanel sessionId={agentBoardSession}/>:<CompanionSettingsPanel sessionId={agentBoardSession}/>;
  render(panel);await screen.findByRole('alert');vi.useFakeTimers();await languagesKeep(()=>expect(screen.getByRole('alert').textContent).toBe(t(scenario.key)));
});
