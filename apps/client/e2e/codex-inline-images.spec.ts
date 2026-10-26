import {expect,test,type Page} from '@playwright/test';
import {openFollowTranscript} from './fixtures/chatTranscript';
import {preview,prepareRecordedImages,optIn,show,counters,closeWithoutSideEffects} from './fixtures/recorded-images/browser';

async function setup(page:Page,file:string|null='regions.png') {
  await prepareRecordedImages(page);
  const external:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).origin!==new URL(page.url()).origin)external.push(request.url());});
  await page.evaluate(imagePreview=>{
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>)=>{
      if(command!=='agent_transcript'||!['claude','codex'].includes(String(args.agent)))throw new Error('Unexpected Codex image fixture command');
      window.recordedImageFixture.calls.push(args);
      if(args.agent==='claude')return {schemaVersion:1,agent:'claude',view:'active_branch',nextOffset:1,hasMore:false,
        messages:[{id:'starting-branch',role:'assistant',blocks:[{type:'text',text:'Starting Claude conversation'}]}]};
      if(args.view!==undefined)throw new Error('Codex Records must not request a conversation view');
      return {schemaVersion:1,agent:'codex',view:'record_stream',nextOffset:100,hasMore:false,messages:[
        ...(imagePreview?[{id:'codex-user-image',role:'user',blocks:[{type:'image',text:'Owned Codex image',
          ...(args.inlineImages===true?{imagePreview}:{})}]}]:[]),
        {id:'codex-inert-user',role:'user',blocks:[
          {type:'image',text:'File reference: file-fixture-id'},
          {type:'image',text:'Local reference: /fixture/private.png'},
          {type:'image',text:'Remote reference: https://images.example.invalid/codex-private.png'},
          {type:'image',text:'Unknown media: image/webp'},
        ]},
        {id:'codex-inert-assistant',role:'assistant',blocks:[{type:'image',text:'Assistant generated image placeholder'}]},
        {id:'codex-inert-tool',role:'tool',blocks:[{type:'tool_result',text:'Tool image: https://images.example.invalid/codex-tool.png'}]},
      ]};
    }}});
  },file?preview(file):null);
  await openFollowTranscript(page);
  await expect(page.getByText('Starting Claude conversation',{exact:true})).toBeVisible();
  await page.getByLabel('Include recorded images',{exact:true}).check();
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await page.getByRole('combobox',{name:'Agent',exact:true}).selectOption('codex');
  await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/codex.jsonl');
  return external;
}
async function openRecords(page:Page) {
  await page.getByRole('button',{name:'Open transcript',exact:true}).click();
  await expect(page.getByText('File reference: file-fixture-id',{exact:true})).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
}

test('switching from an opted-in Claude conversation establishes Codex Records with image admission off',async({page})=>{
  const external=await setup(page);
  await expect(page.getByRole('combobox',{name:'View',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Include recorded images',{exact:true})).not.toBeChecked();
  await openRecords(page);
  const initial=(await counters(page)).calls.at(-1)!;
  expect(initial).toMatchObject({agent:'codex',path:'/fixture/codex.jsonl',offset:0});
  expect(initial).not.toHaveProperty('view');expect(initial).not.toHaveProperty('inlineImages');
  await expect(page.getByRole('button',{name:'View recorded image',includeHidden:true})).toHaveCount(0);
  await optIn(page);
  const admitted=(await counters(page)).calls.at(-1)!;
  expect(admitted).toMatchObject({agent:'codex',inlineImages:true});expect(admitted).not.toHaveProperty('view');
  expect((await counters(page)).decodes).toBe(0);
  const canvas=await show(page);
  expect(await canvas.evaluate(element=>{
    const c=element as HTMLCanvasElement,ctx=c.getContext('2d')!;
    return [c.width,c.height,...ctx.getImageData(4,8,1,1).data,...ctx.getImageData(28,8,1,1).data];
  })).toEqual([32,16,255,0,0,255,0,0,255,255]);
  await closeWithoutSideEffects(page,external);
});

test('Codex recorded JPEG uses actual EXIF-oriented bitmap pixels and releases its canvas',async({page})=>{
  const external=await setup(page,'regions-orientation6.jpg');
  await optIn(page);
  const canvas=await show(page);
  const regions=await canvas.evaluate(element=>{
    const c=element as HTMLCanvasElement,ctx=c.getContext('2d')!;
    return {size:[c.width,c.height],top:Array.from(ctx.getImageData(8,4,1,1).data),bottom:Array.from(ctx.getImageData(8,28,1,1).data)};
  });
  expect(regions.size).toEqual([16,32]);
  expect(regions.top[3]).toBe(255);expect(regions.bottom[3]).toBe(255);
  expect(regions.top[1]).toBeLessThan(15);expect(regions.bottom[1]).toBeLessThan(15);
  expect(regions.top[0]-regions.top[2]).toBeGreaterThan(240);
  expect(regions.bottom[2]-regions.bottom[0]).toBeGreaterThan(240);
  await closeWithoutSideEffects(page,external);
});

test('Codex file, local, remote, tool, assistant and unsupported media remain inert placeholders',async({page})=>{
  const external=await setup(page,null);
  await optIn(page);
  const records=page.locator('article');
  await expect(records).toHaveCount(3);
  for(const summary of await records.locator('summary').all())await summary.click();
  await expect(page.getByText('Remote reference: https://images.example.invalid/codex-private.png',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'View recorded image',includeHidden:true})).toHaveCount(0);
  await expect(records.locator('img,canvas,[src],[href]')).toHaveCount(0);
  expect(await counters(page)).toMatchObject({decodes:0,closed:0,urls:0,drafts:0});
  expect(external).toEqual([]);
});
