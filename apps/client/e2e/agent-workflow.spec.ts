import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const messages=[
  {id:'p',role:'user',blocks:[{type:'text',text:'Run the review workflow'}]},
  {id:'a',role:'assistant',blocks:[{type:'tool_use',id:'w1',name:'Workflow',text:'{}'}]},
];
const agents=(second:string)=>[
  {agentId:'a1',label:'review:#1',phase:'Review',state:'done',toolCalls:7,tokens:500,last:'No findings',childPath:'/fixture/wf/agent-a1.jsonl'},
  {agentId:'a2',label:'review:#2',phase:'Review',state:second},
  {agentId:'a3',label:'fix:#1',phase:'Fix',state:'running'},
];
const work=(second:string)=>[{id:'w1',kind:'workflow',title:'review-fix',state:'running',events:[],startedAt:new Date().toISOString(),
  workflow:{name:'review-fix',phases:[{title:'Review',state:second==='running'?'running':'done'},{title:'Fix',state:'running'}],agents:agents(second),totals:{agents:3,tokens:900,toolCalls:12}}}];
const children={'/fixture/wf/agent-a1.jsonl':[{id:'c0',role:'user',blocks:[{type:'text',text:'Review PR 1'}]},{id:'c1',role:'assistant',blocks:[{type:'text',text:'Reviewed: no findings.'}]}]};

test('a workflow is a live tree that updates in place and opens an agent',async({page})=>{
  await openAgentWork(page,messages,{work:work('running')},children);
  await page.getByRole('region',{name:'Background work'}).getByRole('button',{name:/running/}).click();
  const tree=page.getByRole('region',{name:'Workflow review-fix'});
  await expect(tree).toContainText('3 agents · 12 tool calls · 900 tokens');
  await expect(tree.getByText('review:#2')).toBeVisible();
  const box=(await tree.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await tree.getByRole('button',{name:'Open conversation'}).click();
  await expect(page.getByText('Reviewed: no findings.')).toBeVisible();
  await page.getByRole('button',{name:'Back to the conversation'}).click();
  await expect(page.getByText('Reviewed: no findings.')).toHaveCount(0);
  await expect(tree.getByText('review:#1')).toBeVisible();
});
