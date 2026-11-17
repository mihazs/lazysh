// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import UsageCollectorPanel from './UsageCollectorPanel';
import {ageMs,entryHeadline,entryStale,type UsageCollectorReply,type UsageCollectorStatus} from './usageCollector';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();});

const observed='2026-11-14T12:05:00Z';
const entry={id:'anthropic',name:'Claude',status:'ready' as const,stale:false,fetchedAt:'2026-11-14T11:59:00Z',rows:[{label:'Session',percent:42.5,reading:'used' as const,resetAt:null,windowSeconds:null},{label:'Weekly',percent:20,reading:'left' as const,resetAt:null,windowSeconds:null}]};
const status:UsageCollectorStatus={
  schemaVersion:1,observedAt:observed,policyRevision:2,accountQuotaEnabled:true,
  collector:{enabled:true,intervalMinutes:30,timer:{state:'installed',linger:true}},
  lastRun:{at:'2026-11-14T12:00:00Z',outcome:'recorded',reason:null},
  samples:{state:'ok',count:2,oldest:'2026-11-13T12:00:00Z',newest:'2026-11-14T12:00:00Z',bytes:900},
  recent:[{recordedAt:'2026-11-14T12:00:00Z',source:'builtin',truncated:false,entries:[entry]},{recordedAt:'2026-11-13T12:00:00Z',source:'builtin',truncated:false,entries:[{...entry,id:'openai',name:'Codex',stale:true,rows:[]}]}],
};
const ready=(change:Partial<UsageCollectorStatus>={}):UsageCollectorReply=>({state:'ready',status:{...status,...change}});
function open(reply:UsageCollectorReply|Error) {
  if(reply instanceof Error)vi.mocked(invoke).mockRejectedValue(reply);else vi.mocked(invoke).mockResolvedValue(reply);
  return render(<UsageCollectorPanel sessionId="ssh1"/>);
}

it('asks the host once for its status and shows the collector, its last run and every sample age',async()=>{
  open(ready());
  await screen.findByText(/On: about one sample every 30 min/);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith('usage_collector_status',{sessionId:'ssh1'},{headers:{'X-Lazysh-Access':expect.any(String)}});
  expect(screen.getByText(/Last run/).textContent).toContain('recorded a sample');
  expect(screen.getByText('2 samples recorded',{exact:false})).toBeTruthy();
  const samples=within(screen.getByRole('list',{name:'Recorded samples, newest first'})).getAllByRole('listitem');
  expect(samples).toHaveLength(2);
  expect(samples[0].textContent).toContain('Claude: Weekly 20% left');
  expect(samples[0].textContent).not.toContain('stale');
  // A sample with a stale entry and no quota row says so; it is never shown as zero.
  expect(samples[1].textContent).toContain('Codex: no quota reported (stale)');
  expect(screen.queryByText(/\b0%/)).toBeNull();
});

it('says a collector that is off records nothing and how to turn it on',async()=>{
  open(ready({collector:{enabled:false,intervalMinutes:30,timer:{state:'absent',linger:null}},lastRun:null,samples:{state:'ok',count:0,oldest:null,newest:null,bytes:0},recent:[]}));
  await screen.findByText(/Off: this host records no usage/);
  expect(screen.getByText(/lazysh-agent usage-collector enable/)).toBeTruthy();
  expect(screen.getByText('No run recorded yet.')).toBeTruthy();
  expect(screen.getByText(/No samples yet\. A missing sample is unknown, never zero\./)).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
});

it.each([
  ['absent',/no timer is installed/],
  ['drift',/not what lazysh installed/],
  ['unsupported',/no user service manager/],
] as const)('explains a timer that is %s while the collector is on',async(state,message)=>{
  open(ready({collector:{enabled:true,intervalMinutes:30,timer:{state,linger:null}}}));
  expect((await screen.findByRole('status')).textContent).toMatch(message);
});

it('explains lingering, a forbidden quota read and an unreadable sample file',async()=>{
  open(ready({collector:{enabled:true,intervalMinutes:5,timer:{state:'installed',linger:false}},accountQuotaEnabled:false,lastRun:{at:'2026-11-14T12:00:00Z',outcome:'skipped',reason:'accountQuotaDisabled'},samples:{state:'invalid',count:0,oldest:null,newest:null,bytes:0},recent:[]}));
  await screen.findByText(/Without lingering/);
  expect(screen.getByText(/does not allow account usage reads, so the collector records nothing/)).toBeTruthy();
  expect(screen.getByText(/skipped: this host does not allow account usage reads/)).toBeTruthy();
  expect(screen.getByText(/cannot be read\. Delete usage-samples\.json/)).toBeTruthy();
});

it('shows an offline run without inventing a sample',async()=>{
  open(ready({lastRun:{at:'2026-11-14T12:00:00Z',outcome:'unavailable',reason:'timeout'},samples:{state:'ok',count:0,oldest:null,newest:null,bytes:0},recent:[]}));
  await screen.findByText(/no report, no sample \(timeout\)/);
  expect(screen.getByText(/No samples yet/)).toBeTruthy();
});

it('tells the user to update a companion that has no collector',async()=>{
  open({state:'companion_required'});
  await screen.findByText('Update the host companion to see its background usage collection.');
  expect(screen.queryByRole('list')).toBeNull();
});

it('shows a failed read as an error and reloads on request',async()=>{
  vi.mocked(invoke).mockRejectedValueOnce(new Error('The host answered nothing')).mockResolvedValueOnce(ready());
  render(<UsageCollectorPanel sessionId="ssh1"/>);
  expect((await screen.findByRole('alert')).textContent).toBe('The host answered nothing');
  fireEvent.click(screen.getByRole('button',{name:'Refresh collection'}));
  await screen.findByText(/On: about one sample every 30 min/);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('drops the old host and reads the new one when the session changes',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(ready()).mockResolvedValueOnce(ready({collector:{enabled:true,intervalMinutes:60,timer:{state:'installed',linger:true}}}));
  const {rerender}=render(<UsageCollectorPanel sessionId="old"/>);
  await screen.findByText(/every 30 min/);
  rerender(<UsageCollectorPanel sessionId="new"/>);
  await screen.findByText(/every 60 min/);
  expect(screen.queryByText(/every 30 min/)).toBeNull();
  await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith('usage_collector_status',{sessionId:'new'},expect.anything()));
});

it('ages a sample against the host clock, then by the time since the answer, and keeps an impossible time unknown',()=>{
  const received=1_000_000;
  expect(ageMs('2026-11-14T12:00:00Z',observed,received,received)).toBe(5*60_000);
  expect(ageMs('2026-11-14T12:00:00Z',observed,received,received+60_000)).toBe(6*60_000);
  // A time after the host's own answer, or one that does not parse, is unknown: never "just now".
  expect(ageMs('2026-11-14T13:00:00Z',observed,received,received)).toBeNull();
  expect(ageMs('yesterday',observed,received,received)).toBeNull();
});

it('marks provider data stale when flagged, failed, undated or older than ten minutes when recorded',()=>{
  const at='2026-11-14T12:00:00Z';
  expect(entryStale(entry,at)).toBe(false);
  expect(entryStale({...entry,stale:true},at)).toBe(true);
  expect(entryStale({...entry,status:'error'},at)).toBe(true);
  expect(entryStale({...entry,fetchedAt:null},at)).toBe(true);
  expect(entryStale({...entry,fetchedAt:'2026-11-14T11:49:00Z'},at)).toBe(true);
  expect(entryHeadline({...entry,rows:[]})).toBeNull();
  expect(entryHeadline({...entry,rows:[{...entry.rows[1],percent:90}]})).toBe('Weekly 90% left');
});
