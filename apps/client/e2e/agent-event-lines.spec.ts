import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const event=(id:string,kind:string,text:string,detail?:string)=>({id,role:'event',blocks:[],event:{kind,text,...(detail?{detail}:{})}});
const messages=[
  {id:'p',role:'user',blocks:[{type:'text',text:'Ship the feature'}]},
  event('e1','goal','Merge every ready PR'),
  event('e2','planMode',''),
  {id:'a1',role:'assistant',blocks:[{type:'text',text:'Planning.'}]},
  event('e3','planModeExit',''),
  event('e4','hookFailed','PostToolUse:Read','Failed with non-blocking status code: boom'),
  event('e5','recap','Merged two PRs; waiting on CI.'),
  event('e6','goalMet','Merge every ready PR','All PRs are merged.'),
  event('e7','compacted',''),
];

test('goal, plan mode, recap, failed hook and compaction records are one muted line each, details on tap',async({page})=>{
  await openAgentWork(page,messages);
  const events=page.locator('.agent-event');
  await expect(events).toHaveCount(7);
  await expect(events.locator('p, summary')).toHaveText(['Goal set · Merge every ready PR','Plan mode on','Plan mode off','Hook failed · PostToolUse:Read','Recap · Merged two PRs; waiting on CI.','Goal reached · Merge every ready PR','Conversation compacted']);
  await events.nth(3).locator('summary').click();
  await expect(events.nth(3).locator('pre')).toHaveText('Failed with non-blocking status code: boom');
  await events.nth(5).locator('summary').click();
  await expect(events.nth(5).locator('pre')).toHaveText('All PRs are merged.');
  const viewport=page.viewportSize()!;
  for(let index=0;index<7;index++) {
    const box=(await events.nth(index).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
  }
});
