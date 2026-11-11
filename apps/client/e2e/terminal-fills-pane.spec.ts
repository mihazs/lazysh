import {expect,test,type Page} from '@playwright/test';
import {connectLocalTerminal,installLocalTerminal} from './fixtures/localTerminal';

/** The terminal beside the free area it may use: the session body down to the toolbar,
 * or to the status bar when the toolbar is hidden. Insets are 0 in a browser. */
const measure=(page:Page)=>page.evaluate(()=>{
  const box=(selector:string)=>document.querySelector(selector)!.getBoundingClientRect();
  const body=box('.session-body'),keys=document.querySelector('.terminal-keys')?.getBoundingClientRect();
  const surface=box('.terminal-canvas .xterm-viewport'),grid=box('.terminal-canvas .xterm-screen');
  const viewport=document.querySelector<HTMLElement>('.terminal-canvas .xterm-viewport')!;
  const free={left:body.left,top:body.top,right:body.right,bottom:keys?.top??body.bottom};
  const {cols,rows}=window.simpleShortcutResizes.at(-1)!;
  return {width:document.documentElement.clientWidth,free,surface:{left:surface.left,top:surface.top,right:surface.right,bottom:surface.bottom},
    grid:{left:grid.left,top:grid.top,right:grid.right,bottom:grid.bottom,cols,rows,cell:grid.width/cols,row:grid.height/rows},
    // A classic scrollbar legitimately takes width from the text; an overlay one takes none.
    scrollbar:viewport.offsetWidth-viewport.clientWidth};
});

/** Every side of the free area is painted by the terminal and its text grid fills it to within one cell. */
async function expectFilled(page:Page) {
  const m=await measure(page),{free,surface,grid}=m;
  for(const side of ['left','top','right','bottom'] as const)expect(Math.abs(surface[side]-free[side]),`terminal surface ${side}`).toBeLessThanOrEqual(2);
  expect(grid.left-free.left,'text starts at the left edge').toBeLessThanOrEqual(2);
  expect(grid.top-free.top,'text starts at the top edge').toBeLessThanOrEqual(2);
  expect(grid.cols,'columns that fit').toBe(Math.floor((free.right-free.left-m.scrollbar)/grid.cell+1e-6));
  expect(grid.rows,'rows that fit').toBe(Math.floor((free.bottom-free.top)/grid.row+1e-6));
  // The PTY, not only the screen, has the full size.
  expect(await page.evaluate(()=>window.simpleShortcutResizes.at(-1))).toEqual({cols:grid.cols,rows:grid.rows});
  return m;
}

test('the terminal fills the free area edge to edge, with the soft keyboard closed and open',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await installLocalTerminal(page);
  await page.goto('/');
  await connectLocalTerminal(page);
  await page.evaluate(()=>window.simpleShortcutOutput('hello\r\n'));
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutResizes.length)).toBeGreaterThan(0);
  const settled=async()=>{await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await page.waitForTimeout(150);};
  await settled();
  const closed=await expectFilled(page);
  // Nothing around the session body may leave a gutter on a phone.
  if(phone){expect(closed.free.left).toBe(0);expect(closed.free.right).toBe(closed.width);}
  await page.screenshot({path:testInfo.outputPath('filled-closed.png')});
  if(!phone)return;
  const size=page.viewportSize()!;
  // An Android soft keyboard shrinks the window, and the pane with it.
  await page.setViewportSize({width:size.width,height:size.height-320});
  await settled();
  const open=await expectFilled(page);
  expect(open.grid.rows).toBeLessThan(closed.grid.rows);
  await page.screenshot({path:testInfo.outputPath('filled-keyboard.png')});
  await page.setViewportSize(size);
  await settled();
  expect((await expectFilled(page)).grid.rows).toBe(closed.grid.rows);
});
