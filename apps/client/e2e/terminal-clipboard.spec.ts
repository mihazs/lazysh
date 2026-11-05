import {expect,test,type Page} from '@playwright/test';
import {openClipboardTerminal} from './fixtures/localTerminal';

const screen=(page:Page)=>page.locator('.terminal-canvas:visible .xterm-screen');
const output=(page:Page,text:string)=>page.evaluate(text=>window.simpleShortcutOutput(text),text);
const readClipboard=(page:Page)=>page.evaluate(()=>navigator.clipboard.readText());
const encode=(text:string)=>Buffer.from(text,'utf8').toString('base64');


/** Viewport coordinates of a visible cell, measured from xterm's own character probe. */
async function cellPoint(page:Page,row:number,column:number) {
  const box=(await screen(page).boundingBox())!;
  const {rows,width}=await screen(page).evaluate(node=>{
    const probe=node.closest('.xterm')!.querySelector('.xterm-char-measure-element')!;
    return {rows:node.querySelectorAll('.xterm-rows > div').length,width:probe.getBoundingClientRect().width/Math.max(1,(probe.textContent??'').length)};
  });
  return {x:box.x+(column+.5)*width,y:box.y+(row+.5)*box.height/rows};
}

test.describe('remote clipboard (OSC 52)',()=>{
  const requests:[string,(text:string)=>string][]=[
    ['plain',text=>`\x1b]52;c;${encode(text)}\x07`],
    ['tmux passthrough',text=>`\x1bPtmux;\x1b\x1b]52;c;${encode(text)}\x07\x1b\\`],
    ['tmux passthrough with a wrapped ST',text=>`\x1bPtmux;\x1b\x1b]52;c;${encode(text)}\x1b\x1b\\\x1b\\`],
    ['screen passthrough',text=>`\x1bP\x1b]52;c;${encode(text)}\x07\x1b\\`],
  ];
  for(const [name,wrap] of requests)test(`${name} asks first and Allow writes the real clipboard`,async({page})=>{
    await openClipboardTerminal(page);
    const text=`OSC52 ${name} · 世界`;
    const sequence=wrap(text);
    // Chunk boundaries inside the escape sequence must not matter.
    for(const part of [sequence.slice(0,5),sequence.slice(5,17),sequence.slice(17)])await output(page,part);
    await output(page,'VISIBLE_AFTER');
    const region=page.getByRole('region',{name:'Remote clipboard request',exact:true});
    await expect(region).toContainText(text);
    await expect(screen(page)).toContainText('VISIBLE_AFTER');
    expect(await readClipboard(page)).toBe('BEFORE');
    await region.getByRole('button',{name:'Allow this copy',exact:true}).click();
    await expect(region).toHaveCount(0);
    await expect.poll(()=>readClipboard(page)).toBe(text);
  });

  test('Deny, queries and oversized requests never touch the clipboard',async({page})=>{
    await openClipboardTerminal(page);
    const region=page.getByRole('region',{name:'Remote clipboard request',exact:true});
    await output(page,`\x1bPtmux;\x1b\x1b]52;c;${encode('DENIED')}\x07\x1b\\`);
    await region.getByRole('button',{name:'Deny',exact:true}).click();
    await expect(region).toHaveCount(0);
    await output(page,'\x1b]52;c;?\x07');
    await output(page,`\x1b]52;c;${Buffer.alloc(65537,'a').toString('base64')}\x07`);
    await output(page,'SETTLED');
    await expect(screen(page)).toContainText('SETTLED');
    await expect(region).toHaveCount(0);
    expect(await readClipboard(page)).toBe('BEFORE');
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  });
});

test('a terminal link offers Open in browser and Copy URL',async({page},testInfo)=>{
  await openClipboardTerminal(page);
  const url='https://example.invalid/owned/path?q=1';
  await output(page,`\x1b[2J\x1b[Hsee ${url} here\r\n`);
  await expect(screen(page)).toContainText(url);
  const target=await cellPoint(page,0,10);
  const activate=async()=>{
    if(testInfo.project.name==='phone')await page.touchscreen.tap(target.x,target.y);
    else {await page.mouse.move(target.x,target.y);await page.mouse.move(target.x+1,target.y);await page.mouse.click(target.x+1,target.y);}
  };
  const region=page.getByRole('region',{name:'Terminal link',exact:true});
  await expect(async()=>{await activate();await expect(region).toBeVisible({timeout:1000});}).toPass();
  await expect(region).toContainText(url);
  await region.getByRole('button',{name:'Copy URL',exact:true}).click();
  await expect.poll(()=>readClipboard(page)).toBe(url);
  await region.getByRole('button',{name:'Open in browser',exact:true}).click();
  await expect(region).toHaveCount(0);
  expect(await page.evaluate(()=>window.simpleShortcutOpened)).toEqual([url]);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
});

test('toolbar Paste sends the real clipboard text to the terminal',async({page})=>{
  await openClipboardTerminal(page);
  await page.evaluate(()=>navigator.clipboard.writeText('pasted from clipboard'));
  const paste=page.locator('.terminal-keys').getByRole('button',{name:'paste',exact:true});
  await paste.click();
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites.join(''))).toBe('pasted from clipboard');
});

test.describe('touch selection',()=>{
  test.beforeEach(({},testInfo)=>test.skip(testInfo.project.name!=='phone','Requires touch input.'));
  // Rows 2-5 stay blank so the selection handles and actions never cover the next target.
  const rows=['first OWNED_WORD tail','second line','','','','','third LAST_WORD end'];
  /** A still finger held past the long-press delay, optionally moved before lifting. */
  async function hold(page:Page,from:{x:number;y:number},then:{x:number;y:number}[]=[]) {
    const input=await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
    await page.waitForTimeout(650);
    for(const point of then)await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await input.detach();
  }
  const selection=(page:Page)=>page.locator('.terminal-canvas .xterm-selection > div').count();

  test('long-press selects the word, Copy writes it and a second long-press extends raw rows',async({page})=>{
    await openClipboardTerminal(page);
    await output(page,`\x1b[2J\x1b[H${rows.join('\r\n')}`);
    await expect(screen(page)).toContainText('LAST_WORD');
    const copy=page.locator('.terminal-keys').getByRole('button',{name:'Copy',exact:true});
    await hold(page,await cellPoint(page,0,9));
    await expect.poll(()=>selection(page)).toBeGreaterThan(0);
    await copy.click();
    await expect.poll(()=>readClipboard(page)).toBe('OWNED_WORD');
    await hold(page,await cellPoint(page,6,9));
    await copy.click();
    await expect.poll(()=>readClipboard(page)).toBe('OWNED_WORD tail\nsecond line\n\n\n\n\nthird LAST_WORD');
    // A long-press inside the selection starts a new one at that word.
    await hold(page,await cellPoint(page,1,2));
    await copy.click();
    await expect.poll(()=>readClipboard(page)).toBe('second');
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  });

  for(const order of ['move then hold','hold then move'])test(`a finger that moves (${order}) scrolls history and selects nothing`,async({page})=>{
    await openClipboardTerminal(page);
    await output(page,Array.from({length:200},(_,i)=>`history ${i}`).join('\r\n'));
    const viewport=page.locator('.terminal-canvas:visible .xterm-viewport');
    await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(500);
    const before=await viewport.evaluate(node=>node.scrollTop);
    const start=await cellPoint(page,4,4);
    const input=await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
    if(order==='hold then move')await page.waitForTimeout(650);
    for(let step=1;step<=6;step++)await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:start.y+step*30}]});
    if(order==='move then hold')await page.waitForTimeout(650);
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await input.detach();
    await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeLessThan(before);
    expect(await selection(page)).toBe(0);
  });
});
