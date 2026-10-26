import {expect,test,type Page} from '@playwright/test';
import {openFollowTranscript} from './fixtures/chatTranscript';
import {preview,prepareRecordedImages,optIn,show,counters,expectCleared,closeWithoutSideEffects} from './fixtures/recorded-images/browser';

declare global {interface Window {claudeImageBranch:'image'|'away';}}
async function setup(page:Page,file='regions.png',view:'records'|'conversation'='conversation') {
  await prepareRecordedImages(page);
  await page.evaluate(imagePreview=>{
    window.claudeImageBranch='image';
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>)=>{
      if(command!=='agent_transcript'||args.agent!=='claude')throw new Error('Unexpected Claude image fixture command');
      window.recordedImageFixture.calls.push(args);
      const branch=args.view==='conversation';
      const messages=branch&&window.claudeImageBranch==='away'
        ? [{id:'other-branch',role:'assistant',blocks:[{type:'text',text:'A different current branch'}]}]
        : [
          {id:'owned-user-image',role:'user',blocks:[{type:'image',text:'Owned user image',...(args.inlineImages===true?{imagePreview}:{})}]},
          {id:'inert-user-uri',role:'user',blocks:[{type:'image',text:'https://images.example.invalid/private.png'}]},
          {id:'inert-assistant-image',role:'assistant',blocks:[{type:'image',text:'Assistant image placeholder'}]},
          {id:'inert-nested-tool-image',role:'user',blocks:[{type:'tool_result',text:'Nested tool image: https://images.example.invalid/tool.png'}]},
        ];
      return {schemaVersion:1,agent:'claude',view:branch?'active_branch':'record_stream',branchId:window.claudeImageBranch,
        truncated:false,nextOffset:100,hasMore:false,messages};
    }}});
  },preview(file));
  await openFollowTranscript(page);
  if(view==='records') {
    await page.getByRole('combobox',{name:'View',exact:true}).selectOption(view);
    await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  }
  await expect(page.getByText('Owned user image',{exact:true})).toHaveCount(1);
}

for(const [mode,file,width,height] of [['records','regions.png',32,16],['conversation','regions-orientation6.jpg',16,32]] as const)
test(`Claude ${mode} requires explicit image admission and View, then decodes owned pixels`,async({page})=>{
  await setup(page,file,mode);
  expect((await counters(page)).calls.every(call=>!Object.hasOwn(call,'inlineImages'))).toBe(true);
  await expect(page.getByLabel('Include recorded images',{exact:true})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'View recorded image',includeHidden:true})).toHaveCount(0);
  await optIn(page);
  expect((await counters(page)).calls.at(-1)).toMatchObject({agent:'claude',inlineImages:true,...(mode==='conversation'?{view:mode}:{})});
  expect((await counters(page)).decodes).toBe(0);
  await expect(page.getByRole('button',{name:'View recorded image',includeHidden:true})).toHaveCount(1);
  const external:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).origin!==new URL(page.url()).origin)external.push(request.url());});
  const canvas=await show(page);
  const actual=await canvas.evaluate(element=>{
    const c=element as HTMLCanvasElement,context=c.getContext('2d')!,rotated=c.height>c.width;
    return {width:c.width,height:c.height,red:[...context.getImageData(rotated?8:4,rotated?4:8,1,1).data],
      blue:[...context.getImageData(rotated?8:28,rotated?28:8,1,1).data]};
  });
  expect(actual).toMatchObject({width,height});
  expect(actual.red[0]).toBeGreaterThan(240);expect(actual.red[2]).toBeLessThan(15);
  expect(actual.blue[2]).toBeGreaterThan(240);expect(actual.blue[0]).toBeLessThan(15);
  expect(await page.locator('article img,article [src],article [href]').count()).toBe(0);
  await closeWithoutSideEffects(page,external);
});

test('same-source branch replacement retires image selection even when the original row returns',async({page})=>{
  await setup(page);await optIn(page);await show(page);
  const refresh=page.getByRole('button',{name:'Refresh new messages',exact:true});
  await page.evaluate(()=>{window.claudeImageBranch='away';});
  await refresh.click();
  await expect(page.getByText('A different current branch',{exact:true})).toBeVisible();
  await expectCleared(page);
  await page.evaluate(()=>{window.claudeImageBranch='image';});
  await refresh.click();
  await expect(page.getByText('Owned user image',{exact:true})).toHaveCount(1);
  const calls=(await counters(page)).calls.slice(-2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject({view:'conversation',offset:0,inlineImages:true,path:'/fixture/claude.jsonl'});
  await expect(page.getByRole('img',{name:'Recorded image preview',exact:true,includeHidden:true})).toHaveCount(0);
  expect((await counters(page)).decodes).toBe(1);
  await show(page);
  expect((await counters(page)).decodes).toBe(2);
});

test('Claude access revocation clears pixels and a fresh mount still requires a fresh View',async({page})=>{
  await setup(page);await optIn(page);await show(page);
  await page.evaluate(()=>{window.chatFollow.revoke();});
  await expectCleared(page);
  await page.evaluate(()=>{window.chatFollow.dispose();});
  await openFollowTranscript(page);
  await expect(page.getByLabel('Include recorded images',{exact:true})).not.toBeChecked();
  expect((await counters(page)).decodes).toBe(1);
  await optIn(page);
  expect((await counters(page)).decodes).toBe(1);
  await show(page);
  expect((await counters(page)).decodes).toBe(2);
});
