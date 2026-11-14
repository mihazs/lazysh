// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {useAccountUsage} from './useAccountUsage';
import {AccountUsageBar,AccountUsageDetails} from './AccountUsage';
import type {AccountUsageEntry,AccountUsageResponse} from './accountUsageReport';
import {usageTarget,type UsageBarMode} from './usageAgentProvider';

vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});

const entry=(id:string,name:string,percent:number,patch:Partial<AccountUsageEntry>={}):AccountUsageEntry=>({id,name,shortName:id.slice(0,3),plan:'Pro',status:'ready',stale:false,fetchedAt:new Date().toISOString(),resetCredits:null,
  rows:[{type:'metric',label:'Weekly',percent,value:`${percent}%`,detail:'',headline:'percent',reading:'used',resetAt:null,windowSeconds:null,regen:null,modelPool:false}],...patch});
const reply=(entries:AccountUsageEntry[],primary='anthropic'):AccountUsageResponse=>({schemaVersion:1,state:'ready',source:'builtin',report:{primary,entries}});
const accounts=[entry('anthropic','Claude',100),entry('openai','Codex',35),entry('copilot','GitHub Copilot',7),entry('anthropic_api','Anthropic API',1)];

function Surface({mode='follow',provider='',agent}:{mode?:UsageBarMode;provider?:string;agent:string|null|undefined}) {
  const model=useAccountUsage('ssh1',true,usageTarget(mode,provider,agent));
  return <><AccountUsageBar model={model} onOpen={()=>{}}/><AccountUsageDetails model={model}/></>;
}
const chip=()=>screen.getByRole('button',{name:'Open AI account usage'});

it('shows the account of the agent in the pane and re-links when the agent changes, without another host read',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply(accounts));
  const {rerender}=render(<Surface agent="claude"/>);
  await vi.waitFor(()=>expect(chip().textContent).toBe('Claude 100% used'));
  rerender(<Surface agent="codex"/>);expect(chip().textContent).toBe('Codex 35% used');
  rerender(<Surface agent="Cursor CLI"/>);expect(chip().textContent).toBe('Cursor: no account reported');
  rerender(<Surface agent="agy"/>);expect(chip().textContent).toBe('Antigravity: no account reported');
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('falls back to the chosen default account, else the host default, when no agent is detected',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply(accounts,'openai'));
  const {rerender}=render(<Surface agent={null}/>);
  await vi.waitFor(()=>expect(chip().textContent).toBe('Codex 35% used'));
  rerender(<Surface agent={null} provider="copilot"/>);expect(chip().textContent).toBe('GitHub Copilot 7% used');
  rerender(<Surface agent="claude" provider="copilot"/>);expect(chip().textContent).toBe('Claude 100% used');
});
it('says an agent without a supported account has no usage instead of showing another agent’s quota',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply(accounts));
  render(<Surface agent="gemini"/>);
  await vi.waitFor(()=>expect(chip().textContent).toBe('No usage for gemini'));
  expect(chip().querySelector('meter')).toBeNull();
});
it('shows a neutral label while the pane has not been read and never the default account',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply(accounts));
  const {rerender}=render(<Surface agent={undefined}/>);
  expect(chip().textContent).toBe('AI usage…');
  await vi.waitFor(()=>expect(screen.getByRole('button',{name:'Refresh'})).toHaveProperty('disabled',false));
  expect(chip().textContent).toBe('AI usage…');
  rerender(<Surface agent="codex"/>);expect(chip().textContent).toBe('Codex 35% used');
});
it('pins the chosen account in fixed mode whatever the pane runs, and falls back to the host default without one',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply(accounts,'openai'));
  const {rerender}=render(<Surface mode="fixed" provider="copilot" agent="claude"/>);
  await vi.waitFor(()=>expect(chip().textContent).toBe('GitHub Copilot 7% used'));
  rerender(<Surface mode="fixed" provider="" agent="claude"/>);expect(chip().textContent).toBe('Codex 35% used');
});
it('keeps a stale snapshot of the followed account marked stale, and reports an unreadable host honestly',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(reply([entry('anthropic','Claude',100,{fetchedAt:new Date(Date.now()-3_600_000).toISOString()}),entry('openai','Codex',35)]))
    .mockResolvedValueOnce({schemaVersion:1,state:'timeout',report:null});
  render(<Surface agent="claude"/>);
  await vi.waitFor(()=>expect(screen.getAllByLabelText('Stale account usage').length).toBeGreaterThan(0));
  expect(chip().textContent).toContain('Claude 100% used');
  fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
  await screen.findByText('The account usage refresh timed out.');
  expect(chip().textContent).toContain('Claude 100% used');expect(screen.getAllByLabelText('Stale account usage').length).toBeGreaterThan(0);
});
it('shows unavailable, not another account, when the host cannot report at all',async()=>{
  vi.mocked(invoke).mockResolvedValue({schemaVersion:1,state:'companion_required',report:null});
  render(<Surface agent="claude"/>);
  await vi.waitFor(()=>expect(chip().textContent).toBe('AI usage: setup'));
});
it('marks a provider error of the followed account unavailable and stale',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply([entry('openai','Codex',35,{status:'error'}),entry('anthropic','Claude',100)]));
  render(<Surface agent="codex"/>);
  await vi.waitFor(()=>expect(chip().textContent).toContain('Codex 35% used'));
  expect(chip().textContent).toContain('stale');
});
it('lets the details page pick another account without moving the bar, until the followed agent changes',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply(accounts));
  const {rerender}=render(<Surface agent="claude"/>);
  await vi.waitFor(()=>expect(chip().textContent).toBe('Claude 100% used'));
  expect((screen.getByLabelText('Provider account') as HTMLSelectElement).value).toBe('anthropic');
  fireEvent.change(screen.getByLabelText('Provider account'),{target:{value:'copilot'}});
  expect((screen.getByLabelText('Provider account') as HTMLSelectElement).value).toBe('copilot');expect(chip().textContent).toBe('Claude 100% used');
  rerender(<Surface agent="codex"/>);expect(chip().textContent).toBe('Codex 35% used');
  expect((screen.getByLabelText('Provider account') as HTMLSelectElement).value).toBe('openai');
});
it('opens the details page on the followed account, or the host default when the agent has none',async()=>{
  vi.mocked(invoke).mockResolvedValue(reply(accounts));
  const {rerender}=render(<Surface agent="codex"/>);
  await vi.waitFor(()=>expect((screen.getByLabelText('Provider account') as HTMLSelectElement).value).toBe('openai'));
  rerender(<Surface agent="gemini"/>);expect((screen.getByLabelText('Provider account') as HTMLSelectElement).value).toBe('anthropic');
});
