import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const ago=(minutes:number)=>new Date(Date.now()-minutes*60_000).toISOString();
const messages=[{id:'p',role:'user',blocks:[{type:'text',text:'Check the build in the background'}]}];
const work=[
  {id:'a1',kind:'agent',title:'Audit the tests',subtitle:'general-purpose',state:'running',startedAt:ago(5),events:[]},
  {id:'m1',kind:'monitor',title:'CI checks',command:'gh pr checks 1',state:'running',startedAt:ago(4),timeoutMs:1_800_000,events:['lint: pass','tests: pass'],last:'tests: pass'},
  {id:'b1',kind:'shell',title:'Wait for the deploy',command:'sleep 600',state:'done',startedAt:ago(30),endedAt:ago(20),events:[],summary:'Background command completed (exit code 0)'},
  {id:'b2',kind:'shell',title:'Forgotten server',state:'running',startedAt:ago(13*60),events:[]},
];

test('the panel lists whole-conversation work, shows monitor output and flags an old launch, inside the viewport',async({page})=>{
  await openAgentWork(page,messages,{work});
  const panel=page.getByRole('region',{name:'Background work'});
  await expect(panel.getByRole('button',{name:'2 running',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'2 running',exact:true}).click();
  await expect(panel.getByRole('listitem').first()).toContainText('Audit the tests');
  await panel.getByRole('button',{name:'1 monitor'}).click();
  const monitors=panel.getByRole('list',{name:'1 monitor'});
  await monitors.getByText('CI checks').click();
  await expect(monitors.getByLabel('Recorded output')).toHaveText('lint: pass\ntests: pass');
  await panel.getByRole('button',{name:'1 shell',exact:true}).click();
  const shells=panel.getByRole('list',{name:'2 shells'});
  await expect(shells.getByRole('listitem').filter({hasText:'Forgotten server'})).toContainText('Not confirmed');
  await expect(shells.getByRole('listitem').filter({hasText:'Wait for the deploy'})).toContainText('Done');
  const box=(await panel.boundingBox())!,viewport=page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
});

test('without a work list from the companion the panel reads the loaded messages',async({page})=>{
  await openAgentWork(page,[...messages,{id:'a',role:'assistant',blocks:[{type:'tool_use',id:'t1',name:'Agent',text:'{"description":"Audit it","run_in_background":true}'}]}]);
  await expect(page.getByRole('button',{name:'1 running',exact:true})).toBeVisible();
});
