import {expect,test} from '@playwright/test';

const stamp=(seconds:number)=>new Date(Date.now()-seconds*1000).toISOString();
const use=(id:string,name:string,input:object,seconds:number)=>({id:`use-${id}`,role:'assistant',timestamp:stamp(seconds),blocks:[{type:'tool_use',id,name,text:JSON.stringify(input)}]});
const messages=[
  {id:'prompt',role:'user',timestamp:stamp(400),blocks:[{type:'text',text:'Run the release checks'}]},
  use('s1','Bash',{command:'gh run watch 1',description:'Watch CI',run_in_background:true},300),
  use('m1','Monitor',{description:'Wait for tests',command:'tail -f log'},200),
  ...['One','Two','Three','Four'].map((name,index)=>use(`a${index}`,'Agent',{description:`Review ${name}`,subagent_type:'general-purpose',run_in_background:true},100-index)),
];

test('the status panel lists background work compactly and stays inside the viewport',async({page})=>{
  await page.goto('/');
  await page.evaluate(messages=>{
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async()=>({schemaVersion:1,agent:'claude',view:'active_branch',messages,nextOffset:1,hasMore:false})}});
  },messages);
  await page.evaluate(async()=>{(await import('/e2e/fixtures/AgentStatusHarness.tsx')).mountAgentStatusHarness();});
  const panel=page.getByRole('region',{name:'Background work'});
  await expect(panel.getByRole('button',{name:'6 running'})).toBeVisible();
  await expect(panel.getByRole('button',{name:'1 shell'})).toBeVisible();
  await expect(panel.getByRole('button',{name:'1 monitor'})).toBeVisible();
  await panel.getByRole('button',{name:'6 running'}).click();
  await expect(panel.getByRole('listitem')).toHaveCount(3);
  await panel.getByRole('button',{name:'1 more'}).click();
  await expect(panel.getByRole('listitem')).toHaveCount(4);
  await expect(panel.getByRole('listitem').first()).toContainText('general-purpose');
  await panel.getByRole('button',{name:'1 shell'}).click();
  await expect(panel.getByRole('list',{name:'1 shell'})).toContainText('Watch CI');
  const box=await panel.boundingBox(),viewport=page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width);
});
