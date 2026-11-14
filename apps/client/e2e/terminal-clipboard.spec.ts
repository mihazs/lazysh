import {expect,test,type Page,type TestInfo} from '@playwright/test';
import {openClipboardTerminal} from './fixtures/localTerminal';
import {pressMore} from './fixtures/toolbarMore';

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

/** Presses a cell until the link region opens: xterm only offers a link after the pointer reached it. */
async function tapLink(page:Page,projectName:string,row:number,column:number) {
  const target=await cellPoint(page,row,column);
  const region=page.getByRole('region',{name:'Terminal link',exact:true});
  await expect(async()=>{
    if(projectName==='phone')await page.touchscreen.tap(target.x,target.y);
    else {await page.mouse.move(target.x,target.y);await page.mouse.move(target.x+1,target.y);await page.mouse.click(target.x+1,target.y);}
    await expect(region).toBeVisible({timeout:1000});
  }).toPass();
  return region;
}
async function terminalColumns(page:Page) {
  return screen(page).evaluate(node=>{
    const probe=node.closest('.xterm')!.querySelector('.xterm-char-measure-element')!;
    return Math.floor(node.getBoundingClientRect().width/(probe.getBoundingClientRect().width/Math.max(1,(probe.textContent??'').length)));
  });
}

test('a terminal link offers Open in browser and Copy URL',async({page},testInfo)=>{
  await openClipboardTerminal(page);
  const url='https://example.invalid/owned/path?q=1';
  await output(page,`\x1b[2J\x1b[Hsee ${url} here\r\n`);
  await expect(screen(page)).toContainText(url);
  const region=await tapLink(page,testInfo.project.name,0,10);
  await expect(region).toContainText(url);
  await region.getByRole('button',{name:'Copy URL',exact:true}).click();
  await expect.poll(()=>readClipboard(page)).toBe(url);
  await region.getByRole('button',{name:'Open in browser',exact:true}).click();
  await expect(region).toHaveCount(0);
  expect(await page.evaluate(()=>window.simpleShortcutOpened)).toEqual([url]);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
});

test.describe('URLs that fill more than one row',()=>{
  for(const [name,wrap] of [
    ['soft-wrapped by the terminal',(url:string)=>url],
    ['broken at the last column by a program or multiplexer',(url:string,columns:number)=>url.match(new RegExp(`.{1,${columns}}`,'g'))!.join('\r\n')],
  ] as const)test(`tapping the second row of a URL ${name} opens the whole URL`,async({page},testInfo)=>{
    await openClipboardTerminal(page);
    const columns=await terminalColumns(page);
    const url=`https://example.invalid/${'long-path-segment/'.repeat(Math.ceil(columns/18)+1)}end?q=1&r=two`;
    await output(page,`\x1b[2J\x1b[H${wrap(url,columns)}\r\nnext line\r\n`);
    const region=await tapLink(page,testInfo.project.name,1,2);
    await expect(region).toContainText(url);
    await region.getByRole('button',{name:'Open in browser',exact:true}).click();
    await expect(region).toHaveCount(0);
    expect(await page.evaluate(()=>window.simpleShortcutOpened)).toEqual([url]);
  });
  test('an application hyperlink (OSC 8) wins over the URL its own text looks like',async({page},testInfo)=>{
    await openClipboardTerminal(page);
    await output(page,'\x1b[2J\x1b[H\x1b]8;;https://owned.invalid/target?a=1\x1b\\https://shown.invalid/label\x1b]8;;\x1b\\ https://other.invalid/plain\r\n');
    const region=await tapLink(page,testInfo.project.name,0,2);
    await expect(region).toContainText('https://owned.invalid/target?a=1');
    await region.getByRole('button',{name:'Open in browser',exact:true}).click();
    expect(await page.evaluate(()=>window.simpleShortcutOpened)).toEqual(['https://owned.invalid/target?a=1']);
  });
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
    const copy={click:()=>pressMore(page,'Copy')};
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

test.describe('host file paths in the output',()=>{
  const log='/var/log/build.log',home='/home/fixture/notes/todo.md';
  async function tap(page:Page,testInfo:TestInfo,row:number,column:number) {
    const target=await cellPoint(page,row,column);
    if(testInfo.project.name==='phone')await page.touchscreen.tap(target.x,target.y);
    else {await page.mouse.move(target.x,target.y);await page.mouse.move(target.x+1,target.y);await page.mouse.click(target.x+1,target.y);}
  }
  test('an existing path offers View, Download and Copy path; prose and missing files stay plain',async({page},testInfo)=>{
    await page.addInitScript(([log,home])=>{window.simpleShortcutFiles={[log]:'first line\nsecond line',[home]:'# todo'};},[log,home]);
    await openClipboardTerminal(page);
    await output(page,`\x1b[2J\x1b[Hwrote ${log}:2 now\r\nsee ~/notes/todo.md\r\nmissing /no/such/file.txt\r\n`);
    await expect(screen(page)).toContainText('missing /no/such/file.txt');
    const region=page.getByRole('region',{name:'Host file',exact:true});
    // The host is asked about each candidate before it becomes a link: the missing file never opens a sheet.
    await tap(page,testInfo,2,12);
    await expect.poll(()=>page.evaluate(()=>window.simpleShortcutHostCalls)).toContain('host_file_stat /no/such/file.txt');
    await tap(page,testInfo,2,12);
    await page.waitForTimeout(300);
    await expect(region).toHaveCount(0);
    await expect(async()=>{await tap(page,testInfo,0,10);await expect(region).toBeVisible({timeout:1000});}).toPass();
    await expect(region).toContainText(log);
    await expect(region).toContainText('Line 2');
    await region.getByRole('button',{name:'View',exact:true}).click();
    await expect(region).toContainText('second line');
    await region.getByRole('button',{name:'Download',exact:true}).click();
    await expect(region).toContainText('Saved to /downloads/saved.');
    await region.getByRole('button',{name:'Copy path',exact:true}).click();
    await expect.poll(()=>readClipboard(page)).toBe(log);
    expect(await page.evaluate(()=>window.simpleShortcutHostCalls)).toContain('host_file_deliver save');
    await region.getByRole('button',{name:'Dismiss file',exact:true}).click();
    await expect(region).toHaveCount(0);
  });
  test('~/ resolves against the host home and a relative path against the OSC 7 directory',async({page},testInfo)=>{
    await page.addInitScript(([home])=>{window.simpleShortcutFiles={[home]:'# todo','/work/app/src/main.rs':'fn main() {}'};},[home]);
    await openClipboardTerminal(page);
    const region=page.getByRole('region',{name:'Host file',exact:true});
    await output(page,`\x1b[2J\x1b[Hsee ~/notes/todo.md\r\n`);
    await expect(async()=>{await tap(page,testInfo,0,8);await expect(region).toBeVisible({timeout:1000});}).toPass();
    await expect(region).toContainText(home);
    await region.getByRole('button',{name:'Dismiss file',exact:true}).click();
    await output(page,`\x1b]7;file://host/work/app\x07\x1b[2J\x1b[Herror in ./src/main.rs:3:9\r\n`);
    await expect(async()=>{await tap(page,testInfo,0,14);await expect(region).toBeVisible({timeout:1000});}).toPass();
    await expect(region).toContainText('/work/app/src/main.rs');
  });
});
