import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const minutesAgo=(minutes:number)=>new Date(Date.now()-minutes*60_000).toISOString();
const messages=[
  {id:'p',role:'user',blocks:[{type:'text',text:'Check the build in the background'}]},
  {id:'a',role:'assistant',blocks:[{type:'tool_use',id:'a1',name:'Agent',text:'{"description":"Audit the tests"}'},
    {type:'tool_use',id:'m1',name:'Monitor',text:'{"description":"CI checks"}'}]},
];
const work=[
  {id:'a1',kind:'agent',title:'Audit the tests',subtitle:'general-purpose',state:'running',startedAt:minutesAgo(5),events:[]},
  {id:'m1',kind:'monitor',title:'CI checks',command:'gh pr checks 1',state:'running',startedAt:minutesAgo(4),timeoutMs:1_800_000,events:['lint: pass','tests: pass'],last:'tests: pass'},
  {id:'b1',kind:'shell',title:'Wait for the deploy',state:'done',startedAt:minutesAgo(30),endedAt:minutesAgo(20),events:[],summary:'Background command completed (exit code 0)'},
];

test('the pill lists running work, shows monitor output and stays inside the viewport',async({page})=>{
  await openAgentWork(page,messages,{work});
  await expect(page.getByRole('region',{name:'Sub-agents'})).toHaveCount(0);
  const pill=page.getByRole('button',{name:'2 running',exact:true});
  await pill.click();
  const agents=page.getByRole('region',{name:'Sub-agents',exact:true});
  await expect(agents).toContainText('Audit the tests');
  await expect(agents).toContainText('Running');
  const monitors=page.getByRole('region',{name:'Monitors',exact:true});
  await monitors.getByText('CI checks').click();
  await expect(monitors.getByLabel('Recorded output')).toHaveText('lint: pass\ntests: pass');
  await expect(page.getByRole('region',{name:'Background commands',exact:true})).toContainText('Done');
  const viewport=page.viewportSize()!;
  for(const region of [agents,monitors]) {
    const box=(await region.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
  }
  await pill.click();
  await expect(agents).toBeHidden();
});

test('a sub-agent and a monitor appear as rows in their turn instead of raw tool blocks',async({page})=>{
  await openAgentWork(page,messages,{work});
  await page.locator('.agent-turn-activity > summary').click();
  await expect(page.locator('.agent-work-inline')).toHaveCount(2);
  await expect(page.locator('.agent-work-inline').first()).toContainText('Audit the tests');
});
