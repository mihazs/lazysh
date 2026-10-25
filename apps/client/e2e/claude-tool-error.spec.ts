import { openFollowTranscript } from './fixtures/chatTranscript';
import {expect,test} from '@playwright/test';

test('Claude follow replaces recorded tool errors without live controls or stale branch badges',async({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    let reads=0;
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string)=>{
      if(command!=='agent_transcript')throw new Error('Unexpected fixture command');
      const failed=++reads===1;
      return {schemaVersion:1,agent:'claude',view:'active_branch',branchId:failed?'old':'new',hasMore:false,nextOffset:100,
        messages:[{id:failed?'old':'new',role:'user',blocks:[{type:'tool_result',id:'original-call',text:failed?'Original failure output':'Replacement output',isError:failed}]}]};
    }}});
  });
  await openFollowTranscript(page);
  const summary=page.locator('.chat-message summary');
  await expect(summary).toHaveText('tool result · Recorded tool error · Tool ID: original-call');
  await summary.click();
  await expect(page.getByText('Original failure output',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/approve|deny|stop|retry/i})).toHaveCount(0);
  await page.clock.install();
  await page.getByLabel('Follow selected Claude branch').check();
  await page.clock.runFor(2000);
  await expect(summary).toHaveText('tool result');
  await expect(page.getByText('Original failure output',{exact:true})).toHaveCount(0);
  await summary.click();
  await expect(page.getByText('Replacement output',{exact:true})).toBeVisible();
});
