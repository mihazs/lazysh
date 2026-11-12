import {expect,test} from '@playwright/test';
import {openAgentWork} from './fixtures/agentWorkPage';

const update=(id:string,entries:[string,string][])=>({id,role:'assistant',blocks:[{type:'tool_use',name:'TodoWrite',id,text:'{}',
  card:{kind:'plan',entries:entries.map(([text,status])=>({text,status}))}}]});
const messages=[{id:'p',role:'user',blocks:[{type:'text',text:'Build the feature'}]},
  update('a',[['Read the code','completed'],['Write tests','in_progress'],['Ship it','pending']]),
  update('b',[['Read the code','completed'],['Write tests','completed'],['Ship it','in_progress']])];

test('the plan chip expands to the whole list inside the viewport',async({page})=>{
  await openAgentWork(page,messages);
  const chip=page.getByRole('button',{name:/2 of 3/});
  await expect(chip).toContainText('Ship it');
  await chip.click();
  const plan=page.getByRole('region',{name:'Plan',exact:true});
  await expect(plan.getByRole('listitem')).toHaveText(['DoneRead the code','DoneWrite tests','In progressShip it']);
  const box=await plan.boundingBox(),viewport=page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width);
  await chip.click();
  await expect(plan).toBeHidden();
});
