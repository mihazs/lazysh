// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {useAccountUsage} from './useAccountUsage';
import {AccountUsageBar,AccountUsageDetails} from './AccountUsage';
import {accountUsageHeadline,type AccountUsageResponse} from './accountUsage';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
const report:AccountUsageResponse={schemaVersion:1,state:'ready',report:{primary:'codex',entries:[{id:'codex',name:'Codex personal',shortName:'OAI',plan:'Pro',status:'ready',stale:false,fetchedAt:new Date().toISOString(),resetCredits:null,rows:[{type:'metric',label:'Weekly',percent:112.5,value:'112.5%',detail:'Provider-reported quota',headline:'percent',reading:'used',resetAt:null,windowSeconds:null,regen:null,modelPool:false}]}]}};
function Surface({sessionId='ssh1',active=true,onRestoreHostTools}:{sessionId?:string;active?:boolean;onRestoreHostTools?:(restored:()=>void)=>void}) {
 const model=useAccountUsage(sessionId,active);return <><AccountUsageBar model={model} onOpen={()=>{}}/><AccountUsageDetails model={model} onRestoreHostTools={onRestoreHostTools}/></>;
}
it('renders real quota precision above 100 and clamps only its meter',async()=>{
 vi.mocked(invoke).mockResolvedValue(report);render(<Surface/>);
 await screen.findByText('112.5% used');expect(screen.getByRole('meter',{name:'Weekly used'}).getAttribute('value')).toBe('100');
 expect(invoke).toHaveBeenCalledWith('account_usage',{sessionId:'ssh1'},{headers:{'X-Lazysh-Access':expect.any(String)}});
});
it('keeps value balances and refill readings distinct from consumed quota',()=>{
 const entry=report.report!.entries[0];const row=entry.rows[0];
 expect(accountUsageHeadline({...entry,rows:[{...row,type:'metric',label:'Balance',percent:20,value:'$4.00',detail:'',headline:'value',reading:'left',resetAt:null,windowSeconds:null,regen:null,modelPool:false}]}).text).toBe('$4.00');
 expect(accountUsageHeadline({...entry,rows:[{type:'text',label:'Available balance',value:'$12.30',usedCents:null,limitCents:null,percent:null}]})).toEqual({text:'$12.30',percent:null});
});
it('retains a last good snapshot with a stale indicator when refresh fails',async()=>{
 vi.mocked(invoke).mockResolvedValueOnce(report).mockResolvedValueOnce({schemaVersion:1,state:'timeout',report:null});
 render(<Surface/>);await screen.findByText('112.5% used');fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
 await screen.findByText('The account usage refresh timed out.');expect(screen.getByLabelText('Stale account usage')).toBeTruthy();expect(screen.getByText('112.5% used')).toBeTruthy();
});
it('hides another host data immediately and retires old response while waiting to refresh the new host',async()=>{
 let resolve!:(r:AccountUsageResponse)=>void;
 vi.mocked(invoke).mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce({...report,report:{...report.report!,entries:[{...report.report!.entries[0],name:'New host account'}]}});
 const {rerender}=render(<Surface sessionId="old"/>);rerender(<Surface sessionId="new"/>);
 await act(async()=>resolve(report));await waitFor(()=>expect(screen.getByRole('option',{name:'New host account'})).toBeTruthy());
 expect(screen.queryByRole('option',{name:'Codex personal'})).toBeNull();
});
it('does not query hidden documents or inactive sessions and refreshes on returning',async()=>{
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});vi.mocked(invoke).mockResolvedValue(report);
 const {rerender}=render(<Surface/>);expect(invoke).not.toHaveBeenCalled();
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});fireEvent(document,new Event('visibilitychange'));await screen.findByText('112.5% used');
 rerender(<Surface active={false}/>);fireEvent(document,new Event('visibilitychange'));expect(invoke).toHaveBeenCalledTimes(1);
});
it('shows unavailable provider guidance without requiring an external tool or fabricated percentage',async()=>{
 vi.mocked(invoke).mockResolvedValue({schemaVersion:1,state:'unavailable',source:'builtin',report:null});render(<Surface/>);
 await screen.findByText(/Check provider configuration and existing sign-ins/);expect(screen.queryByRole('meter')).toBeNull();expect(screen.queryByText('0% used')).toBeNull();
});
it('renders upstream text as text, never markup',async()=>{
 const entry={...report.report!.entries[0],plan:'<img src=x onerror=alert(1)>',rows:[{type:'text' as const,label:'Credits',value:'<script>secret</script>',usedCents:null,limitCents:null,percent:null}]};
 vi.mocked(invoke).mockResolvedValue({...report,report:{primary:'codex',entries:[entry]}});const {container}=render(<Surface/>);
 await screen.findByText('<script>secret</script>');expect(container.querySelector('script,img')).toBeNull();
});

it('marks a fresh-dated provider error with cached quota as stale',async()=>{
 vi.mocked(invoke).mockResolvedValue({...report,report:{...report.report!,entries:[{...report.report!.entries[0],status:'error',stale:false,fetchedAt:new Date().toISOString()}]}});
 render(<Surface/>);await screen.findByLabelText('Stale account usage');expect(screen.getByText(/Provider unavailable/)).toBeTruthy();
});
it('requests explicit host-tools recovery and refreshes only after the guarded restored callback',async()=>{
 vi.mocked(invoke).mockResolvedValueOnce({schemaVersion:1,source:null,state:'disconnected',report:null}).mockResolvedValueOnce(report);
 let restored!:(()=>void);const recover=vi.fn((callback:()=>void)=>{restored=callback;});render(<Surface onRestoreHostTools={recover}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Reconnect host tools'}));expect(recover).toHaveBeenCalledTimes(1);expect(invoke).toHaveBeenCalledTimes(1);
 act(()=>restored());await screen.findByText('112.5% used');expect(invoke).toHaveBeenCalledTimes(2);expect(screen.queryByRole('button',{name:'Reconnect host tools'})).toBeNull();
});
