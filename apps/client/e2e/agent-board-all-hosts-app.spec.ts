import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';

type Fixture={calls:{command:string;args:Record<string,unknown>}[];ids:Record<string,string>;failing:string[]};
declare global {interface Window {allHostsApp:Fixture}}

const report=(sessionId:string,project:string,state:string,summary:string)=>({sessionId,agent:'Claude Code',project,state,updatedAt:new Date().toISOString(),summary,paneId:null,eventCount:1});
const reports:Record<string,unknown[]>={
  build:[report('api-one','/srv/api','working','Implement parser'),report('api-two','/srv/api','done','Ship release')],
  staging:[report('web-one','/srv/web','needs_attention','Approve the deploy')],
};

/** Two saved hosts, both restored as live connections; each answers its own Agents board. */
async function openTwoHosts(page:Page) {
  await installNativeBridge(page);
  await page.addInitScript(({reports})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'build'},{hostId:'staging'}]));
    window.allHostsApp={calls:[],ids:{},failing:[]};
    let sessions=0;
    const hosts=['build','staging'].map(id=>({id,name:id==='build'?'Build box':'Staging box',hostname:`${id}.invalid`,port:22,username:'dev',fingerprint:'SHA256:fixture',credentialsStored:true}));
    window.nativeFixtureInvoke=async(command,args={})=>{
      if(command.startsWith('plugin:event|'))return 1;
      if(command.startsWith('plugin:'))return;
      if(command==='list_hosts')return hosts;
      if(command==='local_capability'||command==='apple_status_capability')return {available:false,reason:'Synthetic'};
      if(command==='agent_snapshot'){
        const host=Object.entries(window.allHostsApp.ids).find(([,id])=>id===args.sessionId)?.[0];
        window.allHostsApp.calls.push({command,args});
        if(host && window.allHostsApp.failing.includes(host))throw {kind:'ssh_error',message:'Owned fixture companion unavailable'};
        return {schemaVersion:1,sessions:host?reports[host]:[]};
      }
      if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
      if(command==='connect'){
        const sessionId=`native-${++sessions}`;window.allHostsApp.ids[String(args.hostId)]=sessionId;
        window.allHostsApp.calls.push({command,args});return {sessionId};
      }
      if(['resize','ack_output','disconnect','write_stdin','probe_connections','cancel_credential_auth'].includes(command))return;
      if(command==='has_credentials')return false;
      throw new Error(`Agents fixture does not provide ${command}`);
    };
  },{reports});
  await page.goto('/');
  await page.locator('.workspace-restore').getByRole('button',{name:'Restore previous workspace',exact:true}).click();
}

test('two connected hosts merge on the Agents board of the real app, one failing host keeps its error and a row opens its host',async({page},testInfo)=>{
  await openTwoHosts(page);
  await expect.poll(()=>page.evaluate(()=>Object.keys(window.allHostsApp.ids).length)).toBe(2);
  const navigation=page.getByRole('group',{name:'Reported agent activity',exact:true});
  // A phone keeps the navigation behind its menu button.
  const menu=page.getByRole('button',{name:'Open hosts',exact:true});
  if(await menu.isVisible())await menu.click();
  await page.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await page.getByRole('button',{name:'Reported agent activity',exact:true}).click();
  // Host by host, as before: the active connection's own board is the default.
  await expect(navigation.getByText('Implement parser',{exact:true})).toBeVisible();
  await expect(navigation.getByText('Approve the deploy',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>window.allHostsApp.calls.filter(call=>call.command==='agent_snapshot' && call.args.sessionId===window.allHostsApp.ids.staging).length)).toBe(0);

  await navigation.getByRole('button',{name:'All hosts',exact:true}).click();
  await expect(navigation.getByRole('region',{name:'Attention',exact:true}).getByRole('region',{name:'Staging box',exact:true})).toContainText('Approve the deploy');
  await expect(navigation.getByRole('region',{name:'Working',exact:true}).getByRole('region',{name:'Build box',exact:true})).toContainText('Implement parser');
  await expect(navigation.getByRole('region',{name:'Done',exact:true}).getByRole('region',{name:'Build box',exact:true})).toContainText('Ship release');
  await page.screenshot({path:testInfo.outputPath('agents-all-hosts.png'),animations:'disabled'});

  await page.evaluate(()=>window.allHostsApp.failing.push('staging'));
  await navigation.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(navigation.getByRole('alert')).toContainText('Staging box');
  await expect(navigation.getByText('Approve the deploy',{exact:true})).toHaveCount(0);
  await expect(navigation.getByText('Implement parser',{exact:true})).toBeVisible();
  await page.evaluate(()=>{window.allHostsApp.failing=[];});
  await navigation.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(navigation.getByText('Approve the deploy',{exact:true})).toBeVisible();

  // Opening the Staging box report makes that connection the active one; its own board is the default again.
  await navigation.getByRole('button',{name:'Open Claude Code report for /srv/web on Staging box',exact:true}).click();
  await expect(page.locator('.session-switcher-trigger')).toHaveText('Staging box');
  await expect(navigation.getByRole('button',{name:'This host',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(navigation.getByText('Approve the deploy',{exact:true})).toBeVisible();
  await expect(navigation.getByText('Implement parser',{exact:true})).toHaveCount(0);
});
