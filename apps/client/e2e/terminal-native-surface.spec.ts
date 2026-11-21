import {expect,test,type Page} from '@playwright/test';
import {canvas,mountNativeSurface as mount} from './fixtures/nativeSurfacePage';
import {swipe} from './fixtures/touchSwipe';

test.afterEach(async({page})=>{await page.evaluate(()=>window.nativeSurface?.dispose());});

const rectOf=(page:Page)=>page.evaluate(selector=>{const {x,y,width,height}=document.querySelector(selector)!.getBoundingClientRect();return {x,y,width,height};},canvas);
const surfaceCalls=(page:Page,command?:'place'|'remove')=>page.evaluate(command=>window.nativeSurface.calls.filter(call=>!command||call.command===command),command);
/** Every element from the terminal container up to the root, with what it paints. */
const painted=(page:Page)=>page.evaluate(selector=>{
  const rows:{element:string;color:string;image:string}[]=[];
  for(let node:Element|null=document.querySelector(selector);node;node=node.parentElement){
    const style=getComputedStyle(node);
    rows.push({element:`${node.tagName.toLowerCase()}${node.className&&typeof node.className==='string'?`.${node.className.split(' ')[0]}`:''}`,color:style.backgroundColor,image:style.backgroundImage});
  }
  return rows;
},canvas);
const clear={color:'rgba(0, 0, 0, 0)',image:'none'};

/** The page's own alpha at points, read from a screenshot that leaves unpainted areas transparent: 0 is where a surface below would show. */
async function alphaAt(page:Page,points:{x:number;y:number}[]) {
  const png=(await page.screenshot({omitBackground:true,scale:'css'})).toString('base64');
  return page.evaluate(async({png,points})=>{
    const image=await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const context=new OffscreenCanvas(image.width,image.height).getContext('2d')!;
    context.drawImage(image,0,0);
    return points.map(({x,y})=>context.getImageData(Math.round(x),Math.round(y),1,1).data[3]);
  },{png,points});
}
const centre=({x,y,width,height}:{x:number;y:number;width:number;height:number})=>({x:x+width/2,y:y+height/2});

test.describe('native engine',()=>{
  test('attaches through its container and has the shell place the surface on it',async({page})=>{
    await mount(page,'native');
    await expect.poll(()=>surfaceCalls(page,'place').then(calls=>calls.length)).toBeGreaterThan(0);
    const [first]=await surfaceCalls(page,'place'),box=await rectOf(page);
    expect(first).toMatchObject({command:'place',session:'native-surface-fixture',background:0x101311});
    const {anchor}=first as Extract<typeof first,{command:'place'}>;
    for(const side of ['x','y','width','height'] as const)expect(anchor[side],side).toBeCloseTo(box[side],0);
    expect(anchor.dpr).toBe(await page.evaluate(()=>window.devicePixelRatio));
    // The adapter found the container by its id: it reports the container's rectangle as its screen.
    expect(await page.locator(canvas).getAttribute('id')).toBeTruthy();
    expect(await page.evaluate(()=>window.nativeSurface.session.adapter.screenBounds())).toMatchObject({width:box.width,height:box.height});
    expect(await page.evaluate(()=>window.nativeSurface.errors)).toEqual([]);
  });

  test('the surface follows the container when the layout moves it',async({page})=>{
    await mount(page,'native');
    await expect.poll(()=>surfaceCalls(page,'place').then(calls=>calls.length)).toBeGreaterThan(0);
    const before=await rectOf(page);
    await page.evaluate(()=>{window.nativeSurface.chain.closest('section')!.style.paddingTop='48px';});
    await expect.poll(async()=>{
      const last=(await surfaceCalls(page,'place')).at(-1)!;
      return last.command==='place'?last.anchor.y:0;
    }).toBeCloseTo(before.y+48,0);
  });

  test('takes the surface down when the pane ends or is hidden, and places it again when shown',async({page})=>{
    await mount(page,'native');
    await expect.poll(()=>surfaceCalls(page,'place').then(calls=>calls.length)).toBeGreaterThan(0);
    await page.evaluate(()=>window.nativeSurface.setActive(false));
    await expect.poll(()=>surfaceCalls(page,'remove').then(calls=>calls.length)).toBe(1);
    await page.evaluate(()=>window.nativeSurface.setActive(true));
    await expect.poll(()=>surfaceCalls(page).then(calls=>calls.at(-1)?.command)).toBe('place');
    await page.evaluate(()=>window.nativeSurface.unmount());
    await expect.poll(()=>surfaceCalls(page).then(calls=>calls.at(-1)?.command)).toBe('remove');
    expect((await surfaceCalls(page,'remove')).length).toBe(2);
  });
});

test.describe('transparency',()=>{
  test('every ancestor of a native container stops painting, and none does under xterm.js',async({page})=>{
    await mount(page,'native');
    const ancestors=await painted(page);
    expect(ancestors.map(row=>row.element)).toEqual(expect.arrayContaining(['div.terminal-stage','main.workspace','div.app-viewport','body','html']));
    for(const {element,color,image} of ancestors.slice(1))expect({element,color,image}).toEqual({element,...clear});
    const [native]=await alphaAt(page,[centre(await rectOf(page))]);
    expect(native,'a surface below would show through').toBe(0);

    await page.evaluate(()=>window.nativeSurface.dispose());
    await mount(page,'xterm');
    const xterm=await painted(page);
    expect(xterm.find(row=>row.element==='main.workspace')!.color).not.toBe(clear.color);
    expect(xterm.find(row=>row.element==='html')!.color).not.toBe(clear.color);
    const [opaque]=await alphaAt(page,[centre(await rectOf(page))]);
    expect(opaque).toBe(255);
  });

  test('is given back when the pane is hidden and when the shell refuses the surface',async({page})=>{
    await mount(page,'native');
    await page.evaluate(()=>window.nativeSurface.setActive(false));
    expect((await painted(page)).find(row=>row.element==='html')!.color).not.toBe(clear.color);
    await page.evaluate(()=>window.nativeSurface.setActive(true));
    expect((await painted(page)).find(row=>row.element==='html')!.color).toBe(clear.color);
    await page.evaluate(()=>window.nativeSurface.dispose());

    // A release build answers every placement with native_surface_disabled.
    await mount(page,'native',true);
    await expect.poll(()=>page.evaluate(()=>window.nativeSurface.errors)).toEqual(['native_surface_disabled']);
    await expect.poll(async()=>(await painted(page)).find(row=>row.element==='html')!.color).not.toBe(clear.color);
    await expect(page.locator(`${canvas}[data-terminal-surface]`)).toHaveCount(0);
  });
});

test.describe('overlays and input',()=>{
  test('DOM overlays are painted and hit above the pane',async({page})=>{
    await mount(page,'native');
    const box=await rectOf(page),middle=centre(box);
    expect(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.matches('.terminal-canvas'),middle)).toBe(true);
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    const sheet=page.locator('.terminal-composer-sheet');
    await expect(sheet).toBeVisible();
    // The sheet covers the container: it takes the hit and paints, so the surface below is not seen where it is.
    expect(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('.terminal-composer-sheet'),middle)).toBe(true);
    await expect.poll(async()=>(await alphaAt(page,[middle]))[0]).toBe(255);
  });

  test('xterm.js leaves the container as it was: no id, no marker, no surface command',async({page})=>{
    await mount(page,'xterm');
    expect(await page.locator(canvas).evaluate(node=>node.getAttributeNames().sort())).toEqual(['aria-label','class','style']);
    await expect(page.locator(`${canvas} .xterm`)).toBeVisible();
    await page.waitForTimeout(300);
    expect(await surfaceCalls(page)).toEqual([]);
  });

  test('a finger drag on the container still scrolls the native terminal',async({page},testInfo)=>{
    test.skip(testInfo.project.name!=='phone','Finger drags need a touch screen.');
    await mount(page,'native');
    await page.evaluate(()=>window.nativeSurface.output(Array.from({length:80},(_,i)=>`LINE_${i}\r\n`).join('')));
    await expect.poll(()=>page.evaluate(()=>window.nativeSurface.session.adapter.viewport().following)).toBe(true);
    const box=await rectOf(page),top=await page.evaluate(()=>window.nativeSurface.session.adapter.viewport().top);
    await swipe(page,[box.x+box.width/2,box.y+box.height/4],[box.x+box.width/2,box.y+box.height*3/4]);
    await expect.poll(()=>page.evaluate(()=>window.nativeSurface.session.adapter.viewport().top)).toBeLessThan(top);
    expect(await page.evaluate(()=>window.nativeSurface.core!.calls)).toContain('scroll');
  });
});
