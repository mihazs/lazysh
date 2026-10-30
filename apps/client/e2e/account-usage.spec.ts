import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
test('account quota uses one accessible footer row at 393px and localizes without another read',async({page},testInfo)=>{
  await page.setViewportSize({width:393,height:852});
  await installNativeBridge(page);
  await page.addInitScript(()=>{
    let reads=0;Object.defineProperty(window,'accountQuotaReads',{get:()=>reads});
    window.nativeFixtureInvoke=async(command)=>{
      if(command==='list_hosts')return [{id:'quota-host',name:'Quota host',hostname:'long-hostname-for-owned-responsive-fixture.example.invalid',username:'long-user-name',port:22}];
      if(command==='local_capability')return {available:false,reason:'Owned browser fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='credential_protection')return {available:false,reason:'Owned browser fixture'};
      if(command==='connect')return {sessionId:'quota-session'};
      if(command==='account_usage'){reads++;return {schemaVersion:1,source:'builtin',state:'ready',report:{primary:'codex',entries:[{id:'codex',name:'Codex account',shortName:'LONG-PROVIDER-ACCOUNT',plan:'Pro',status:'ready',stale:false,fetchedAt:new Date().toISOString(),resetCredits:null,rows:[{type:'metric',label:'Weekly',percent:12345.67,value:'12345.67%',detail:'Owned quota fixture',headline:'percent',reading:'used',resetAt:null,windowSeconds:null,regen:null,modelPool:false}]}]}};}
      if(command.startsWith('plugin:event|')||['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      throw new Error(`Unexpected account quota fixture command: ${command}`);
    };
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Quota host',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('owned-browser-fixture');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  const chip=page.getByRole('button',{name:'Open AI account usage',exact:true});
  await expect(chip).toContainText('12,345.67% used');
  const layout=await chip.evaluate(button=>{
    const footer=button.closest('footer')!;const withChip=footer.getBoundingClientRect().height;
    (button as HTMLElement).style.display='none';const withoutChip=footer.getBoundingClientRect().height;(button as HTMLElement).style.removeProperty('display');
    return {withChip,withoutChip,target:button.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,footerOverflow:footer.scrollWidth>footer.clientWidth};
  });
  if(testInfo.project.name==='phone'){expect(layout.target).toBeGreaterThanOrEqual(44);expect(layout.withChip).toBeLessThanOrEqual(45);}else{expect(layout.withChip).toBeLessThanOrEqual(layout.withoutChip+0.5);}expect(layout.overflow).toBe(false);expect(layout.footerOverflow).toBe(false);
  await chip.click();await expect(page.getByRole('region',{name:'AI account usage',exact:true})).toBeVisible();
  const reads=await page.evaluate(()=>Reflect.get(window,'accountQuotaReads'));
  await page.evaluate(async()=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('pt-BR');});
  await expect(page.getByRole('region',{name:'Uso da conta de IA',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Atualizar',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Reflect.get(window,'accountQuotaReads'))).toBe(reads);
});
