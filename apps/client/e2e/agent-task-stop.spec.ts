import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const started=new Date(Date.now()-120_000).toISOString();
const work=[
  {id:'s1',kind:'shell',title:'Watch CI',state:'running',taskId:'b89pe81sq',startedAt:started,events:[]},
  {id:'a1',kind:'agent',title:'Review the diff',subtitle:'general-purpose',state:'running',taskId:'a84d6fd358bdf59ab',startedAt:started,events:[]},
  {id:'s0',kind:'shell',title:'Finished job',state:'done',taskId:'bdone',startedAt:started,events:[]},
];
const messages=[{id:'prompt',role:'user',timestamp:started,blocks:[{type:'text',text:'Run the release checks'}]}];

test('a running task is stopped by a confirmed request to the agent, once, inside the viewport',async({page})=>{
  await openAgentWork(page,messages,{work});
  // The composer publishes its bound input and the view vouches for the pane; here both are stood in for.
  await page.evaluate(async()=>{
    const {publishComposerControl,publishTaskGuard}=await import('/src/agentDialogAnswer.ts');
    const sent:string[]=[];
    (window as unknown as {sent:string[]}).sent=sent;
    publishComposerControl('fixture-host',{ready:true,busy:false,failed:false,send(){},stop(){},retry(){},answer:async answer=>{if(answer.kind==='send')sent.push(answer.text);return true;}});
    publishTaskGuard('fixture-host',async()=>true);
  });
  const panel=page.getByRole('region',{name:'Background work'});
  await panel.getByRole('button',{name:'2 running'}).click();
  await expect(panel.getByRole('button',{name:/^Stop /})).toHaveCount(1);
  await panel.getByRole('button',{name:'1 shell'}).click();
  await expect(panel.getByRole('button',{name:/^Stop /})).toHaveCount(2);
  await panel.getByRole('button',{name:'Stop Review the diff'}).click();
  const confirm=panel.getByRole('button',{name:'Ask the agent to stop it'});
  await expect(confirm).toBeVisible();
  for(const button of [confirm,panel.getByRole('button',{name:'Keep running'})]){
    const box=(await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  expect(await page.evaluate(()=>(window as unknown as {sent:string[]}).sent)).toEqual([]);
  await confirm.click();
  await expect(panel.getByRole('status').filter({hasText:'Asked the agent to stop it'})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {sent:string[]}).sent)).toEqual(['Stop background task a84d6fd358bdf59ab with the TaskStop tool, then reply only "stopped".']);
});
