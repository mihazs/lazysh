import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const at=(seconds:number)=>new Date(Date.UTC(2026,10,11,10,0,seconds)).toISOString();
const messages=[
  {id:'p',role:'user',timestamp:at(0),blocks:[{type:'text',text:'Fix the bug'}]},
  {id:'t1',role:'assistant',timestamp:at(3),blocks:[{type:'thinking',text:'Look at the **parser** first.'}]},
  {id:'u1',role:'assistant',timestamp:at(4),blocks:[{type:'tool_use',id:'x',name:'Read',text:'{}'}]},
  {id:'t2',role:'assistant',timestamp:at(12),blocks:[{type:'thinking',text:'Then the tests.'},{type:'text',text:'Fixed it.'}]},
];

test('a turn folds its thinking into one timed row that expands to Markdown',async({page})=>{
  await openAgentWork(page,messages);
  const row=page.locator('.agent-thinking');
  await expect(row).toHaveCount(1);
  await expect(row.locator('summary')).toHaveText('Thought for 11 s');
  await expect(page.getByText('Fixed it.')).toBeVisible();
  await row.locator('summary').click();
  await expect(row.locator('strong')).toHaveText('parser');
  await expect(row.getByText('Then the tests.')).toBeVisible();
  const box=(await row.boundingBox())!;
  expect(box.x+box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
