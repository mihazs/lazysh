import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
type QuotaReport=Record<string,unknown>;
// `reports` is served in order by each account_usage read (the last one repeats); omitted, the default fixture is served.
async function connectQuotaHost(page:Page,reports:QuotaReport[]=[]){
  await page.setViewportSize({width:393,height:852});
  await installNativeBridge(page);
  await page.addInitScript((served)=>{
    let reads=0;Object.defineProperty(window,'accountQuotaReads',{get:()=>reads});
    window.nativeFixtureInvoke=async(command)=>{
      if(command==='list_hosts')return [{id:'quota-host',name:'Quota host',hostname:'long-hostname-for-owned-responsive-fixture.example.invalid',username:'long-user-name',port:22}];
      if(command==='local_capability')return {available:false,reason:'Owned browser fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='credential_protection')return {available:false,reason:'Owned browser fixture'};
      if(command==='connect')return {sessionId:'quota-session'};
      if(command==='account_usage'&&served.length){return served[Math.min(reads++,served.length-1)];}
      if(command==='account_usage'){reads++;return {schemaVersion:1,source:'builtin',state:'ready',report:{primary:'codex',entries:[{id:'codex',name:'Codex account',shortName:'LONG-PROVIDER-ACCOUNT',plan:'Pro',status:'ready',stale:false,fetchedAt:new Date().toISOString(),resetCredits:null,rows:[{type:'metric',label:'Weekly',percent:12345.67,value:'12345.67%',detail:'Owned quota fixture',headline:'percent',reading:'used',resetAt:null,windowSeconds:null,regen:null,modelPool:false}]}]}};}
      if(command==='usage_collector_status')return {state:'ready',status:{schemaVersion:1,observedAt:'2026-11-14T12:05:00Z',policyRevision:2,accountQuotaEnabled:true,collector:{enabled:true,intervalMinutes:30,timer:{state:'installed',linger:true}},lastRun:{at:'2026-11-14T12:00:00Z',outcome:'recorded',reason:null},samples:{state:'ok',count:1,oldest:'2026-11-14T12:00:00Z',newest:'2026-11-14T12:00:00Z',bytes:300},recent:[{recordedAt:'2026-11-14T12:00:00Z',source:'builtin',truncated:false,entries:[{id:'codex',name:'Codex account',status:'ready',stale:false,fetchedAt:'2026-11-14T11:59:00Z',rows:[{label:'Weekly',percent:61,reading:'used',resetAt:null,windowSeconds:null}]}]}]}};
      if(command.startsWith('plugin:event|')||['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      throw new Error(`Unexpected account quota fixture command: ${command}`);
    };
  },reports);
  await page.goto('/');
  await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Quota host',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('owned-browser-fixture');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  return page.getByRole('button',{name:'Open AI account usage',exact:true});
}
test('account quota uses one accessible footer row at 393px and localizes without another read',async({page},testInfo)=>{
  const chip=await connectQuotaHost(page);
  await expect(chip).toContainText('12,345.67% used');
  const layout=await chip.evaluate(button=>{
    const footer=button.closest('footer')!;const withChip=footer.getBoundingClientRect().height;
    (button as HTMLElement).style.display='none';const withoutChip=footer.getBoundingClientRect().height;(button as HTMLElement).style.removeProperty('display');
    return {withChip,withoutChip,target:button.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,footerOverflow:footer.scrollWidth>footer.clientWidth};
  });
  if(testInfo.project.name==='phone'){expect(layout.target).toBeGreaterThanOrEqual(44);expect(layout.withChip).toBeLessThanOrEqual(45);}else{expect(layout.withChip).toBeLessThanOrEqual(layout.withoutChip+0.5);}expect(layout.overflow).toBe(false);expect(layout.footerOverflow).toBe(false);
  await chip.click();await expect(page.getByRole('region',{name:'AI account usage',exact:true})).toBeVisible();
  const collector=page.getByRole('region',{name:'Background collection',exact:true});
  await expect(collector).toContainText('On: about one sample every 30 min');
  await expect(collector.getByRole('listitem')).toContainText('Codex account: Weekly 61% used');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)).toBe(false);
  const reads=await page.evaluate(()=>Reflect.get(window,'accountQuotaReads'));
  await page.evaluate(async()=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('pt-BR');});
  await expect(page.getByRole('region',{name:'Uso da conta de IA',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Atualizar',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Coleta em segundo plano',exact:true})).toContainText('Ativada');
  expect(await page.evaluate(()=>Reflect.get(window,'accountQuotaReads'))).toBe(reads);
});
test('the Usage view stacks both panels and keeps each intro behind a disclosure until asked for',async({page})=>{
  await (await connectQuotaHost(page)).click();
  const accountIntro=page.getByText('The status bar follows the agent'),transcriptIntro=page.getByText('Inspect counters and available context');
  const path=page.getByLabel('Usage transcript path',{exact:true});
  await expect(path).toBeVisible();
  const box=await path.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(393);
  await expect(accountIntro).toBeHidden();await expect(transcriptIntro).toBeHidden();
  await page.getByText('About account usage',{exact:true}).click();await expect(accountIntro).toBeVisible();
  await page.getByText('About recorded usage',{exact:true}).click();await expect(transcriptIntro).toBeVisible();
  await page.evaluate(async()=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('pt-BR');});
  await expect(page.getByText('Sobre o uso da conta',{exact:true})).toBeVisible();await expect(page.getByText('Sobre o uso registrado',{exact:true})).toBeVisible();
});

const quotaEntry=(entry:Record<string,unknown>)=>({schemaVersion:1,source:'builtin',state:'ready',report:{primary:'codex',entries:[{id:'codex',name:'Codex account',shortName:'Codex',plan:null,status:'ready',stale:false,fetchedAt:null,resetCredits:null,rows:[],...entry}]}});
test('account quota shows its timestamp and staleness, refreshes on request and keeps unreported data unknown',async({page})=>{
  const old=new Date(Date.now()-3*3600_000).toISOString(),fresh=new Date().toISOString();
  const used={type:'metric',label:'Weekly',percent:40,value:'40%',detail:'',headline:'percent',reading:'used',resetAt:null,windowSeconds:null,regen:null,modelPool:false};
  await (await connectQuotaHost(page,[quotaEntry({fetchedAt:old,rows:[used]}),quotaEntry({fetchedAt:fresh,rows:[{...used,percent:55,value:'55%'}]}),quotaEntry({fetchedAt:null})])).click();
  const details=page.getByRole('region',{name:'AI account usage',exact:true});
  await expect(details).toContainText('Plan not reported · Stale account data');
  await expect(details.locator('time')).toHaveAttribute('datetime',old);
  await expect(details).toContainText('40% used');
  await details.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(details).toContainText('Latest account data');await expect(details).toContainText('55% used');await expect(details.locator('time')).toHaveAttribute('datetime',fresh);
  expect(await page.evaluate(()=>Reflect.get(window,'accountQuotaReads'))).toBe(2);
  await details.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(details).toContainText('Stale account data');await expect(page.getByRole('button',{name:'Open AI account usage',exact:true})).toContainText('No quota reported');
  await expect(details.locator('time')).toHaveCount(0);await expect(details.locator('dd')).toHaveCount(0);await expect(details.locator('meter')).toHaveCount(0);
});
