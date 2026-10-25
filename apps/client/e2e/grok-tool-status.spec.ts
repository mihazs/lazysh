import {expect,test} from '@playwright/test';
declare global {interface Window {grokStatusCalls:number}}

test('Grok tool cards expose recorded status and linkage without live actions or media fetching',async({page})=>{
  const requests:string[]=[];
  page.on('request',request=>{if(request.url().includes('no-fetch.invalid'))requests.push(request.url());});
  await page.goto('/');
  await page.evaluate(async()=>{
    window.grokStatusCalls=0;
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string)=>{
      if(command!=='agent_transcript')throw new Error('Unexpected tool-status fixture command');
      window.grokStatusCalls++;
      return {schemaVersion:1,agent:'grok-acp',view:'record_stream',nextOffset:100,hasMore:false,messages:[
        {id:'grok-record-0',role:'assistant',blocks:[{type:'tool_use',id:'call-one',name:'Inspect source',text:'{"path":"https://no-fetch.invalid/private"}',status:'in_progress'}]},
        {id:'grok-record-20',role:'tool',blocks:[{type:'tool_result',id:'call-one',name:'Tool status',text:'Recorded tool status: failed',status:'failed'}]},
        {id:'grok-record-40',role:'tool',blocks:[{type:'tool_result',id:'call-two',text:'Original output <script>not executed</script>',status:'completed'}]},
        {id:'grok-record-60',role:'tool',blocks:[{type:'image',id:'call-two',text:'Attachment: view in the host agent terminal',status:'pending'}]},
      ]};
    }}});
    const {mountChatFollowHarness}=await import('/e2e/fixtures/ChatFollowHarness.tsx');window.chatFollow=mountChatFollowHarness();
  });
  await page.getByRole('combobox',{name:'Agent',exact:true}).selectOption('grok-acp');
  await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/updates.jsonl');
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  const summaries=page.locator('.chat-message summary');
  for(const status of ['pending','in_progress','completed','failed'])await expect(summaries.filter({hasText:`Recorded status: ${status}`})).toBeVisible();
  await expect(summaries.filter({hasText:'Tool ID: call-one'})).toHaveCount(2);
  await expect(summaries.filter({hasText:'Tool ID: call-two'})).toHaveCount(2);
  await summaries.filter({hasText:'Recorded status: failed'}).click();
  await expect(page.getByText('Recorded tool status: failed',{exact:true})).toBeVisible();
  await summaries.filter({hasText:'Recorded status: completed'}).click();
  await expect(page.getByText('Original output <script>not executed</script>',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Find transcripts',exact:true})).toBeDisabled();
  await expect(page.getByLabel('Follow selected Claude branch')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^(Approve|Deny|Stop|Send)$/i})).toHaveCount(0);
  await expect(page.locator('.chat-message img,.chat-message script,.chat-message iframe')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(await page.evaluate(()=>window.grokStatusCalls)).toBe(1);
});
