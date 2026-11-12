import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const filler=Array.from({length:30},(_,index)=>[
  {id:`p${index}`,role:'user',blocks:[{type:'text',text:`Question ${index}`}]},
  {id:`a${index}`,role:'assistant',blocks:[{type:'text',text:`Answer ${index}\n\n${'More words. '.repeat(40)}`}]},
]).flat();
const messages=[...filler,
  {id:'call',role:'assistant',blocks:[{type:'tool_use',id:'a1',name:'Agent',text:'{"description":"Review the diff"}'}]},
  {id:'end',role:'assistant',blocks:[{type:'text',text:'Final answer'}]}];
const work=[{id:'a1',kind:'agent',title:'Review the diff',subtitle:'general-purpose',state:'done',events:[],last:'No blockers.',childPath:'/fixture/sess/subagents/agent-a1b2.jsonl'},
  {id:'a2',kind:'agent',title:'Pending files',state:'running',startedAt:new Date().toISOString(),events:[]}];
const children={'/fixture/sess/subagents/agent-a1b2.jsonl':[
  {id:'c0',role:'user',blocks:[{type:'text',text:'Review the diff'}]},
  {id:'c1',role:'assistant',blocks:[{type:'text',text:'I read the files. No blockers.'}]}]};

test('a sub-agent opens its own conversation and Back keeps the parent where it was',async({page})=>{
  await openAgentWork(page,messages,{work},children);
  await expect(page.getByText('Final answer')).toBeVisible();
  const list=page.locator('.chat-messages').first();
  await list.evaluate(element=>{element.scrollTop=element.scrollHeight/2;});
  const before=await list.evaluate(element=>element.scrollTop);
  expect(before).toBeGreaterThan(100);

  const panel=page.getByRole('region',{name:'Background work'});
  await panel.getByRole('button',{name:'1 running'}).click();
  await expect(panel.getByRole('button',{name:'Open conversation'})).toHaveCount(1);
  await panel.getByRole('button',{name:'Open conversation'}).click();
  await expect(page.getByText('I read the files. No blockers.')).toBeVisible();
  await expect(page.getByText('Final answer')).toBeHidden();
  const header=page.locator('.agent-child > header');
  await expect(header).toContainText('Review the diff');
  const box=(await header.boundingBox())!;
  expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.getByRole('button',{name:'Back to the conversation'}).click();
  await expect(page.getByText('I read the files. No blockers.')).toHaveCount(0);
  await expect(page.locator('.chat-messages').first()).toBeVisible();
  const after=await page.locator('.chat-messages').first().evaluate(element=>element.scrollTop);
  expect(Math.abs(after-before)).toBeLessThanOrEqual(2);
});
