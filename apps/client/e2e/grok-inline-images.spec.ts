import {expect,test,type Page} from '@playwright/test';
import {openFollowTranscript} from './fixtures/chatTranscript';
import {preview,prepareRecordedImages,optIn,view,show,counters,expectCleared,closeWithoutSideEffects} from './fixtures/recorded-images/browser';

async function setup(page:Page,file='regions.png') {
  await prepareRecordedImages(page);
  await page.evaluate(async(imagePreview)=>{
    const {grokFollowPage}=await import('/src/test/recordedFollowData.ts');
    const f=window.recordedImageFixture;
    Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>)=>{
      if(command!=='agent_transcript')throw new Error('Unexpected image fixture command');
      f.calls.push(args);
      return {...grokFollowPage(),messages:[{id:'grok-record-0',role:'assistant',blocks:[
        {type:'image',text:'Owned recorded image',...(args.inlineImages===true?{imagePreview}:{})},
      ]}]};
    }}});
  },preview(file));
  await openFollowTranscript(page,'grok-acp');
  await expect(page.getByText('Owned recorded image',{exact:true})).toHaveCount(1);
}
test('recorded PNG decoding requires opt-in and View; canvas has original pixels without URLs or prompt writes',async({page})=>{
  await setup(page);
  expect((await counters(page)).calls[0]).not.toHaveProperty('inlineImages');
  await expect(page.getByLabel('Include recorded images',{exact:true})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'View recorded image',exact:true})).toHaveCount(0);
  await optIn(page);
  expect((await counters(page)).decodes).toBe(0);
  expect((await counters(page)).calls[1]).toMatchObject({inlineImages:true,agent:'grok-acp'});
  const external:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).origin!==new URL(page.url()).origin)external.push(request.url());});
  const canvas=await show(page);
  expect(await canvas.evaluate(element=>{
    const c=element as HTMLCanvasElement,context=c.getContext('2d')!;
    return {width:c.width,height:c.height,left:[...context.getImageData(4,8,1,1).data],right:[...context.getImageData(28,8,1,1).data]};
  })).toEqual({width:32,height:16,left:[255,0,0,255],right:[0,0,255,255]});
  await closeWithoutSideEffects(page,external);
  await page.getByRole('button',{name:'Start following recorded file',exact:true}).click();
  await expect(page.getByLabel('Follow recorded file',{exact:true})).toBeChecked();
  expect((await counters(page)).calls.at(-1)).toMatchObject({inlineImages:true,checkpointed:true});
});

test('real JPEG decoder applies EXIF orientation 6 once and preserves the two color regions',async({page})=>{
  await setup(page,'regions-orientation6.jpg');await optIn(page);
  const canvas=await show(page);
  const pixels=await canvas.evaluate(element=>{
    const c=element as HTMLCanvasElement,context=c.getContext('2d')!;
    return {width:c.width,height:c.height,top:[...context.getImageData(8,4,1,1).data],bottom:[...context.getImageData(8,28,1,1).data]};
  });
  expect(pixels).toMatchObject({width:16,height:32});
  expect(pixels.top[0]).toBeGreaterThan(240);expect(pixels.top[2]).toBeLessThan(15);
  expect(pixels.bottom[2]).toBeGreaterThan(240);expect(pixels.bottom[0]).toBeLessThan(15);
  await page.getByRole('button',{name:'Close image preview',exact:true}).click();await expectCleared(page);
});

for(const transition of ['source','lock','unmount'] as const)test(`decoded pixels and bitmap are cleared on ${transition}`,async({page})=>{
  await setup(page);await optIn(page);await show(page);
  const originalPath=await page.getByLabel('Transcript path',{exact:true}).inputValue();
  if(transition==='source')await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/another.jsonl');
  else await page.evaluate(value=>{if(value==='lock')window.chatFollow.revoke();else window.chatFollow.dispose();},transition);
  await expectCleared(page);
  if(transition==='source') {
    await page.getByLabel('Transcript path',{exact:true}).fill(originalPath);
    await expect(page.getByRole('img',{name:'Recorded image preview',exact:true})).toHaveCount(0);
    expect((await counters(page)).decodes).toBe(1);
  }
});

test('a valid animated PNG is rejected before a bitmap is allocated',async({page})=>{
  await setup(page,'regions-animated.png');await optIn(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button',{name:'View recorded image',exact:true})).toHaveCount(0);
  expect((await counters(page)).decodes).toBe(0);
});

test('a real decoded bitmap resolving after a source edit is closed without painting stale pixels',async({page})=>{
  await setup(page);await optIn(page);
  await page.evaluate(()=>{window.recordedImageFixture.hold=true;});
  await view(page);
  await expect.poll(()=>page.evaluate(()=>typeof window.recordedImageFixture.release)).toBe('function');
  await page.getByLabel('Transcript path',{exact:true}).fill('/fixture/replaced.jsonl');
  await page.evaluate(()=>{window.recordedImageFixture.release?.();});
  await expect.poll(async()=>(await counters(page)).closed).toBe(1);
  await expect(page.getByRole('img',{name:'Recorded image preview',exact:true})).toHaveCount(0);
});

test('missing bitmap support reports an error when View is requested',async({page})=>{
  await setup(page);await optIn(page);
  await page.evaluate(()=>{Object.defineProperty(window,'createImageBitmap',{configurable:true,value:undefined});});
  await view(page);
  await expect(page.getByRole('alert')).toHaveText('Recorded image preview is unavailable on this device.');
  await expect(page.getByRole('img',{name:'Recorded image preview',exact:true})).toHaveCount(0);
  expect((await counters(page)).decodes).toBe(0);
});
