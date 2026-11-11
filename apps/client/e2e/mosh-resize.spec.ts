import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {openMoshApp} from './fixtures/moshApp';
import type {Terminal} from '@xterm/xterm';
import {readFileSync} from 'node:fs';
import type {MoshResizeController} from '../src/moshResize';
type Frame={cols:number;rows:number;state:number;bytesHex:string;expectedVisibleRows:number;expectedCursor:number[];expectedLongRow:string;expectedFirstRowBoldRed:boolean};
const captured=JSON.parse(readFileSync(new URL('./fixtures/mosh-resize-frames.json',import.meta.url),'utf8')) as {frames:Frame[]};

type Owned={terminal:Terminal;writes:string[];hook?:MoshResizeController;write(data:string|Uint8Array):Promise<void>;frame(cols:number,rows:number,body?:string):Promise<void>};
declare global {interface Window {ownedMoshResize:{primary:Owned;make(guarded:boolean):Owned;install(terminal:Terminal):MoshResizeController;dispose():void}}}
const bytes=(value:string)=>Array.from(value.matchAll(/../g),part=>Number.parseInt(part[0],16));

test.beforeEach(async({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    const terminalModule='/src/terminal.ts',policyModule='/src/moshResize.ts';
    const {createTerminal}=await import(terminalModule),{installMoshResize}=await import(policyModule);
    const states:{owned:Owned;host:HTMLElement}[]=[];
    const make=(guarded:boolean):Owned=>{
      const host=document.createElement('section');Object.assign(host.style,{position:'fixed',inset:'0',background:'#101010'});document.body.append(host);
      const terminal:Terminal=createTerminal();terminal.options.allowProposedApi=true;terminal.resize(40,12);terminal.open(host);
      let id=100;
      const owned:Owned={terminal,writes:[],write:data=>new Promise(resolve=>terminal.write(data,resolve)),frame(cols,rows,body=''){const next=++id;return owned.write(`\x1b]7777;lazysh-mosh;1;begin;${next};${cols};${rows}\x1b\\${body}\x1b]7777;lazysh-mosh;1;end;${next}\x1b\\`);}};
      terminal.onData(value=>owned.writes.push(value));
      if(guarded)owned.hook=installMoshResize(terminal);
      states.push({owned,host});return owned;
    };
    window.ownedMoshResize={primary:make(true),make,install:installMoshResize,dispose(){for(const {owned,host} of states){owned.hook?.dispose();owned.terminal.dispose();host.remove();}}};
  });
});
test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedMoshResize?.dispose());});

test('actual producer frames duplicate upstream resize history but not canonical Mosh resize',async({page})=>{
  const observations=await page.evaluate(async frames=>{
    const results=[];
    for(const guarded of [false,true]) {
      const owned=guarded?window.ownedMoshResize.primary:window.ownedMoshResize.make(false),terminal=owned.terminal;
      const stages=[];let resizes=0;terminal.onResize(()=>resizes++);
      for(const frame of frames) {
        terminal.resize(frame.cols,frame.rows);await owned.write(new Uint8Array(frame.bytes));
        const buffer=terminal.buffer.normal,all=Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)!.translateToString(true));
        const first=buffer.getLine(buffer.baseY)!.getCell(0)!;
        stages.push({base:buffer.baseY,cursor:[buffer.cursorX,buffer.cursorY],long:all[buffer.baseY+1],bold:!!first.isBold(),fg:first.getFgColor(),counts:Array.from({length:frame.expectedVisibleRows},(_,i)=>all.filter(line=>line.startsWith(`OWNED_ROW_${String(i).padStart(2,'0')}`)).length)});
      }
      results.push({guarded,stages,resizes,writes:owned.writes});
    }
    return results;
  },captured.frames.map(frame=>({...frame,bytes:bytes(frame.bytesHex)})));
  expect(observations[0].stages[1].base).toBe(6);
  expect(observations[0].stages[1].counts).toEqual(Array(6).fill(2));
  const fixed=observations[1];expect(fixed.resizes).toBe(5);expect(fixed.writes).toEqual([]);
  for(const [i,stage] of fixed.stages.entries()) {
    expect(stage.base).toBe(0);expect(stage.counts).toEqual(Array(captured.frames[i].expectedVisibleRows).fill(1));
    expect(stage.cursor).toEqual(captured.frames[i].expectedCursor);expect(stage.long).toBe(captured.frames[i].expectedLongRow);
    expect(stage.bold).toBe(true);expect(stage.fg).toBe(1);
  }
});

test('keeps genuine history cells, styles, markers, selection and viewport anchor until explicit capacity trim',async({page})=>{
  const state=await page.evaluate(async()=>{
    const {terminal:t,write,writes,frame}=window.ownedMoshResize.primary;await frame(40,6);
    await write('\x1b]8;;https://example.invalid/owned-history\x1b\\\x1b[1;31m'+Array.from({length:16},(_,i)=>`HISTORY_${String(i).padStart(2,'0')}_abcdefghijklmnopqrstuvwxyz`).join('\r\n')+'\x1b[0m\x1b]8;;\x1b\\');
    const buffer=t.buffer.normal,base=buffer.baseY;
    const link=()=>(buffer.getLine(0)!.getCell(0)! as unknown as {extended:{urlId:number}}).extended.urlId;const originalLink=link();
    const history=Array.from({length:base},(_,i)=>buffer.getLine(i)!.translateToString(true));
    const marker=t.registerMarker(-buffer.baseY-buffer.cursorY)!;const clipped=t.registerMarker(0)!;
    t.select(0,0,10);const selected=t.getSelection();t.scrollToLine(1);
    await frame(20,3);const narrow={link:link(),base:buffer.baseY,viewport:buffer.viewportY,history:Array.from({length:base},(_,i)=>buffer.getLine(i)!.translateToString(true)),historyWidth:buffer.getLine(0)!.length,selected:t.getSelection(),marker:marker.line,clipped:clipped.isDisposed,bold:!!buffer.getLine(0)!.getCell(0)!.isBold()};
    await frame(40,12);const grown={base:buffer.baseY,viewport:buffer.viewportY,selected:t.getSelection(),historyWidth:buffer.getLine(0)!.length};
    t.options.scrollback=2;
    return {base,history,selected,originalLink,narrow,grown,trimmed:{base:buffer.baseY,markerDisposed:marker.isDisposed,selection:t.getSelection(),length:buffer.length},writes};
  });
  expect(state.base).toBeGreaterThan(2);expect(state.narrow.base).toBe(state.base);expect(state.narrow.viewport).toBe(1);
  expect(state.originalLink).toBeGreaterThan(0);expect(state.narrow.link).toBe(state.originalLink);expect(state.narrow.history).toEqual(state.history);expect(state.narrow.historyWidth).toBe(40);expect(state.narrow.bold).toBe(true);
  expect(state.narrow.selected).toBe(state.selected);expect(state.narrow.marker).toBe(0);expect(state.narrow.clipped).toBe(true);
  expect(state.grown).toEqual({base:state.base,viewport:1,selected:state.selected,historyWidth:40});
  expect(state.trimmed).toEqual({base:2,markerDisposed:true,selection:'',length:14});expect(state.writes).toEqual([]);
});

test('resizes both buffers through one row while the alternate buffer is active and keeps surviving selections',async({page})=>{
  const result=await page.evaluate(async()=>{
    const {terminal:t,write,writes,frame}=window.ownedMoshResize.primary;
    await write('\x1b[1;32mSURVIVING\x1b7\x1b[0m\x1b[12;1HCLIPPED');t.select(0,0,9);const selected=t.getSelection();
    await frame(40,1);const kept=t.getSelection();await frame(40,12);await write('\x1b8Z');const restored=t.buffer.normal.getLine(0)!.getCell(9)!;const savedStyle={bold:!!restored.isBold(),fg:restored.getFgColor()};await write('\x1b[?1049h\x1b[HALT');await frame(20,1);await frame(40,12);
    const alt=t.buffer.active.getLine(0)!.translateToString(true);await write('\x1b[?1049l');
    const normal=t.buffer.normal;return {savedStyle,selected,kept,alt,type:t.buffer.active.type,base:normal.baseY,row:normal.getLine(0)!.translateToString(true),bold:!!normal.getLine(0)!.getCell(0)!.isBold(),writes};
  });
  expect(result).toEqual({savedStyle:{bold:true,fg:2},selected:'SURVIVING',kept:'SURVIVING',alt:'ALT',type:'normal',base:0,row:'SURVIVINGZ',bold:true,writes:[]});
});

test('serial queued producer writes and cropped viewport selection never fabricate history or input',async({page})=>{
  const result=await page.evaluate(async frames=>{
    const owned=window.ownedMoshResize.primary,t=owned.terminal;
    const first=owned.write(new Uint8Array(frames[0]));t.resize(40,6);const second=owned.write(new Uint8Array(frames[1]));await Promise.all([first,second]);
    t.select(0,t.buffer.normal.baseY+5,12);await owned.frame(40,1);
    return {base:t.buffer.normal.baseY,first:t.buffer.normal.getLine(0)!.translateToString(true),selection:t.getSelection(),writes:owned.writes};
  },captured.frames.slice(0,2).map(frame=>bytes(frame.bytesHex)));
  expect(result).toEqual({base:0,first:'OWNED_ROW_00',selection:'',writes:[]});
});

test('rejects malformed private ABI before installing and restores only its own resize descriptor',async({page})=>{
  const result=await page.evaluate(()=>{
    const fixture=window.ownedMoshResize,owned=fixture.primary,t=owned.terminal;owned.hook!.dispose();
    const buffers=(t as unknown as {_core:{_bufferService:{buffers:{resize:(cols:number,rows:number)=>void;alt:{_rows:number}}}}})._core._bufferService.buffers;
    const original=buffers.resize,descriptor=Object.getOwnPropertyDescriptor(buffers,'resize'),rows=buffers.alt._rows;buffers.alt._rows=0;
    let rejected=false;try{fixture.install(t);}catch{rejected=true;}
    const untouched=buffers.resize===original&&Object.getOwnPropertyDescriptor(buffers,'resize')===descriptor;buffers.alt._rows=rows;
    const hook=fixture.install(t);hook.dispose();const restored=buffers.resize===original&&!Object.hasOwn(buffers,'resize');
    const next=fixture.install(t),foreign=()=>{};buffers.resize=foreign;next.dispose();const keptForeign=buffers.resize===foreign;
    return {rejected,untouched,restored,keptForeign};
  });
  expect(result).toEqual({rejected:true,untouched:true,restored:true,keptForeign:true});
});

test('desired resizes leave canonical geometry intact until closed FIFO drain preserves final rows and restores stock resizing',async({page})=>{
  const result=await page.evaluate(async()=>{
    const o=window.ownedMoshResize.primary,t=o.terminal,intents:unknown[]=[],events:unknown[]=[];
    o.hook!.onResizeIntent(size=>intents.push(size));t.onResize(size=>events.push(size));
    await o.frame(40,12,'\x1b[12;1HBOTTOM');t.resize(20,6);t.resize(20,6);await o.frame(40,12,'\x1b[HDELTA');
    const live={size:[t.cols,t.rows],bottom:t.buffer.normal.getLine(11)!.translateToString(true),base:t.buffer.normal.baseY};
    const closing=o.hook!.close();t.resize(70,20);await closing;await o.hook!.close();
    const ended={size:[t.cols,t.rows],base:t.buffer.normal.baseY,bottom:t.buffer.normal.getLine(11)!.translateToString(true),failure:o.hook!.failure};t.resize(50,10);
    return {live,ended,stock:[t.cols,t.rows],intents,events,writes:o.writes};
  });
  expect(result.live).toEqual({size:[40,12],bottom:'BOTTOM',base:0});
  expect(result.ended).toEqual({size:[40,12],base:0,bottom:'BOTTOM',failure:null});expect(result.stock).toEqual([50,10]);
  expect(result.intents).toEqual([{cols:20,rows:6}]);expect(result.events).toEqual([{cols:50,rows:10}]);expect(result.writes).toEqual([]);
});

test('bytewise OSC CSI UTF8 and a 16KiB split remain ordered despite mid-frame desired resizes',async({page})=>{
  const result=await page.evaluate(async frames=>{
    const o=window.ownedMoshResize.primary,t=o.terminal;
    for(const frame of frames){const writes=[];for(let i=0;i<frame.length;i++){writes.push(o.write(new Uint8Array([frame[i]])));if(i===7)t.resize(20,1);}await Promise.all(writes);}
    const unicode=t.buffer.normal.getLine(4)!.translateToString(true);
    const bytes=new TextEncoder().encode('\x1b]7777;lazysh-mosh;1;begin;1000;40;12\x1b\\'+'\x1b[H'+'\x1b[0m'.repeat(5000)+'SAFE'+'\x1b]7777;lazysh-mosh;1;end;1000\x1b\\');
    const first=o.write(bytes.slice(0,16384));t.resize(30,2);const second=o.write(bytes.slice(16384));await Promise.all([first,second]);
    return {unicode,size:[t.cols,t.rows],base:t.buffer.normal.baseY,row:t.buffer.normal.getLine(0)!.translateToString(true),failure:o.hook!.failure,writes:o.writes};
  },captured.frames.slice(0,2).map(frame=>bytes(frame.bytesHex)));
  expect(result).toEqual({unicode:'OWNED_ROW_04_世界',size:[40,12],base:0,row:'SAFED_ROW_00',failure:null,writes:[]});
});

test('malformed nested stale and partial frame envelopes fail closed without input or geometry intent',async({page})=>{
  const results=await page.evaluate(async()=>{
    const f=window.ownedMoshResize,results=[];
    for(const payload of ['lazysh-mosh;2;begin;1;40;12','lazysh-mosh;1;begin;9007199254740992;40;12','lazysh-mosh;1;begin;1;1;12','lazysh-mosh;1;end;1']){
      const o=f.make(true);await o.write(`\x1b]7777;${payload}\x1b\\`);o.terminal.resize(30,5);results.push(o.hook!.failure);
    }
    for(const suffix of ['', '\x1b]7777;lazysh-mosh;1;begin;2;30;5\x1b\\','\x1b]7777;lazysh-mosh;1;end;1\x1b\\\x1b]7777;lazysh-mosh;1;begin;1;40;12\x1b\\']){
      const o=f.make(true);await o.write('\x1b]7777;lazysh-mosh;1;begin;1;40;12\x1b\\'+suffix);await o.hook!.close();results.push(o.hook!.failure);
    }
    const o=f.make(true),pending=o.write('OWNED'),closing=o.hook!.close();o.hook!.dispose();o.hook!.dispose();await closing;await pending;
    return results;
  });
  expect(results).toEqual(['invalid-frame','invalid-frame','invalid-frame','invalid-frame','partial-frame','invalid-frame','invalid-frame']);
});


test('a selection spanning retained history and a surviving viewport prefix is not cleared by narrowing',async({page})=>{
  const result=await page.evaluate(async()=>{
    const o=window.ownedMoshResize.primary,t=o.terminal;await o.frame(40,6);
    await o.write(Array.from({length:10},(_,i)=>`SHORT_${i}`).join('\r\n'));
    const b=t.buffer.normal;t.select(0,b.baseY-1,45);const before=t.getSelection();await o.frame(20,6);
    return {before,after:t.getSelection(),base:b.baseY};
  });
  expect(result.base).toBeGreaterThan(0);expect(result.before).not.toBe('');expect(result.after).toBe(result.before);
});

test('close drains queued complete frames before releasing parser ownership and never applies pending desired crop',async({page})=>{
  const result=await page.evaluate(async()=>{
    const o=window.ownedMoshResize.primary,t=o.terminal;t.resize(20,1);
    const queued=o.frame(41,12,'\x1b[12;1HQUEUED_BOTTOM\x1b[H');const closed=o.hook!.close();t.resize(70,20);await closed;await queued;
    return {size:[t.cols,t.rows],bottom:t.buffer.normal.getLine(11)!.translateToString(true),base:t.buffer.normal.baseY,failure:o.hook!.failure,writes:o.writes};
  });
  expect(result).toEqual({size:[41,12],bottom:'QUEUED_BOTTOM',base:0,failure:null,writes:[]});
});

test('failed parser registration rolls back and authoritative resize listeners can request only future geometry',async({page})=>{
  const result=await page.evaluate(async()=>{
    const f=window.ownedMoshResize,o=f.make(false),t=o.terminal;
    const buffers=(t as unknown as {_core:{_bufferService:{buffers:{resize:unknown}}}})._core._bufferService.buffers;
    const stockBuffer=buffers.resize,stock=t.resize,parser=t.parser,register=parser.registerOscHandler;
    parser.registerOscHandler=()=>{throw new Error('owned registration failure');};let rejected=false;
    try{f.install(t);}catch{rejected=true;}parser.registerOscHandler=register;
    const rolledBack=buffers.resize===stockBuffer&&t.resize===stock;
    o.hook=f.install(t);const intents:unknown[]=[];o.hook.onResizeIntent(size=>intents.push(size));t.onResize(()=>t.resize(30,8));
    await o.frame(20,6,'\x1b[HOWNED');const geometry=[t.cols,t.rows];
    const foreign=()=>{};t.resize=foreign;o.hook.dispose();const preservedForeign=t.resize===foreign&&buffers.resize===stockBuffer;
    const ssh=f.make(false);ssh.terminal.resize(20,6);await ssh.write('ORDINARY');
    return {rejected,rolledBack,geometry,intents,preservedForeign,ssh:{size:[ssh.terminal.cols,ssh.terminal.rows],row:ssh.terminal.buffer.normal.getLine(0)!.translateToString(true)},writes:[...o.writes,...ssh.writes]};
  });
  expect(result).toEqual({rejected:true,rolledBack:true,geometry:[20,6],intents:[{cols:30,rows:8}],preservedForeign:true,ssh:{size:[20,6],row:'ORDINARY'},writes:[]});
});

test('a fresh protected Pane subscriber receives its first same-size measurement without replay on subscription',async({page})=>{
  const result=await page.evaluate(()=>{
    const c=window.ownedMoshResize.primary.hook!,first:unknown[]=[],fresh:unknown[]=[];
    const old=c.onResizeIntent(size=>first.push(size));c.requestSize(80,24);c.requestSize(80,24);old.dispose();
    c.onResizeIntent(size=>fresh.push(size));const atSubscription=fresh.length;c.requestSize(80,24);c.requestSize(80,24);
    return {first,fresh,atSubscription};
  });
  expect(result).toEqual({first:[{cols:80,rows:24}],fresh:[{cols:80,rows:24}],atSubscription:0});
});


test('actual App installs Mosh framing before early output and fits only remote intent across viewport and Compose changes',async({page})=>{
  await openMoshApp(page,'Mosh frame fixture',bytes(captured.frames[0].bytesHex));
  const rows=page.locator('.terminal-canvas .xterm-rows > div');
  await expect(rows).toHaveCount(12);await expect(page.locator('.xterm-screen')).toContainText('OWNED_ROW_11');
  const state=()=>page.evaluate(()=>Reflect.get(window,'nativeMoshApp') as {resizes:{cols:number;rows:number}[];writes:string[];acknowledged:number});
  await expect.poll(async()=>(await state()).resizes.length).toBeGreaterThan(0);
  const firstSize=(await state()).resizes.at(-1)!;expect(firstSize).not.toEqual({cols:40,rows:12});
  if ((page.viewportSize()?.width??1280)<=600) {
    await page.evaluate(()=>Reflect.get(window,'nativeMoshApp').emit(Array.from(new TextEncoder().encode('\x1b[?1000h\x1b[?1006h'))));
    await expect(page.locator('.terminal-canvas .xterm')).toHaveClass(/enable-mouse-events/);
    const box=(await page.locator('.xterm-screen').boundingBox())!,origin={x:box.x+30,y:box.y+40};
    const input=await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
    try {
      await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:origin.y+30}]});
      await expect.poll(async()=>(await state()).writes.length).toBeGreaterThan(0);
      const before=(await state()).writes.length;
      await page.evaluate(data=>Reflect.get(window,'nativeMoshApp').emit([...data,...new TextEncoder().encode('\x1b[?1000h\x1b[?1006h')]),bytes(captured.frames[1].bytesHex));
      await expect(rows).toHaveCount(6);await expect(rows.last()).toContainText('OWNED_ROW_05');
      await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:origin.y+60}]});
      await expect.poll(async()=>(await state()).writes.length).toBeGreaterThan(before);
    } finally {await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await input.detach();}
    expect((await state()).writes.every(value=>/^\x1b\[<6[45];\d+;\d+M$/.test(value))).toBe(true);
    await page.evaluate(()=>{Reflect.get(window,'nativeMoshApp').writes=[];});
  } else {
    await page.evaluate(data=>Reflect.get(window,'nativeMoshApp').emit(data),bytes(captured.frames[1].bytesHex));
    await expect(rows).toHaveCount(6);await expect(rows.last()).toContainText('OWNED_ROW_05');
  }
  // The composer sheet covers the output: neither it nor a viewport change while it is open requests a Mosh resize.
  const beforeCompose=(await state()).resizes.length;await page.getByRole('button',{name:'Compose',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Compose text',exact:true})).toBeFocused();
  await page.setViewportSize({width:830,height:590});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  expect((await state()).resizes.length).toBe(beforeCompose);await expect(rows).toHaveCount(6);
  await page.getByRole('button',{name:'Close composer',exact:true}).click();
  await expect.poll(async()=>(await state()).resizes.length).toBeGreaterThan(beforeCompose);await expect(rows).toHaveCount(6);
  await page.evaluate(data=>{const s=Reflect.get(window,'nativeMoshApp');s.emit(data);s.closed();},bytes(captured.frames[3].bytesHex));
  await expect(rows).toHaveCount(12);await expect(rows.last()).toContainText('OWNED_ROW_11');
  const final=await state();expect(final.writes).toEqual([]);expect(final.resizes.some(size=>size.cols===40&&size.rows===6)).toBe(false);
  expect(final.acknowledged).toBeGreaterThanOrEqual(bytes(captured.frames[0].bytesHex).length+bytes(captured.frames[1].bytesHex).length);
});

test('narrowing clears offscreen history selection endpoints without altering retained history cells',async({page})=>{
  const result=await page.evaluate(async()=>{
    const o=window.ownedMoshResize.primary,t=o.terminal;await o.frame(40,6);
    await o.write(Array.from({length:10},(_,i)=>String(i).repeat(35)+'TAIL!').join('\r\n'));
    const b=t.buffer.normal,row=b.baseY-1,history=b.getLine(row)!.translateToString(false);
    t.select(35,row,4);const before={text:t.getSelection(),position:t.getSelectionPosition()};
    await o.frame(20,6);const narrow={text:t.getSelection(),position:t.getSelectionPosition(),history:b.getLine(row)!.translateToString(false),width:b.getLine(row)!.length};
    await o.frame(40,6);return {before,narrow,widened:b.getLine(row)!.translateToString(false),history,writes:o.writes};
  });
  expect(result.before.text).toBe('TAIL');expect(result.before.position?.end.x).toBe(39);
  expect(result.narrow.history).toBe(result.history);expect(result.narrow.width).toBe(40);expect(result.widened).toBe(result.history);
  expect(result.narrow.text).toBe('');expect(result.narrow.position).toBeUndefined();expect(result.writes).toEqual([]);
});

const moshHistorySource=readFileSync(new URL('../src-tauri/gen/android/app/src/androidTest/assets/owned-mosh-history.js',import.meta.url),'utf8');

for(const dpr of [1,2.625,3])test.describe(`passive rendered-history calibration DPR${dpr}`,()=>{
  test.use({deviceScaleFactor:dpr});
  test('actual producer shrink adds six local history rows only on stock xterm',async({page},info)=>{
    await page.addStyleTag({content:readFileSync(new URL('../../../node_modules/@xterm/xterm/css/xterm.css',import.meta.url),'utf8')});
    await page.evaluate(async()=>{
      const fixture=window.ownedMoshResize;
      const stock=fixture.make(false);Object.assign(window,{ownedMoshStock:stock});
      for(const o of [fixture.primary,stock])await o.write(Array.from({length:20},(_,i)=>`GENUINE_${String(i).padStart(2,'0')}`).join('\r\n'));
    });
    const read=async(guarded:boolean|null)=>{
      const handle=guarded===null?null:await page.evaluateHandle(guarded=>(guarded?window.ownedMoshResize.primary:Reflect.get(window,'ownedMoshStock')).terminal.element,guarded);
      try{return await page.evaluate(({source,root})=>new Function('root',source+';return ownedMoshHistory(root);')(root),{source:moshHistorySource,root:handle});}finally{await handle?.dispose();}
    };
    const observed=[];
    for(const guarded of [false,true]) {
      await page.evaluate(async({guarded,data})=>{
        const o=guarded?window.ownedMoshResize.primary:Reflect.get(window,'ownedMoshStock');o.terminal.resize(40,12);await o.write(new Uint8Array(data));
      },{guarded,data:bytes(captured.frames[0].bytesHex)});
      await expect.poll(()=>read(guarded)).toEqual({valid:true,rows:12,historyRows:8});
      const before=await read(guarded);
      await page.evaluate(async({guarded,data})=>{
        const o=guarded?window.ownedMoshResize.primary:Reflect.get(window,'ownedMoshStock');o.terminal.resize(40,6);await o.write(new Uint8Array(data));
      },{guarded,data:bytes(captured.frames[1].bytesHex)});
      await expect.poll(()=>read(guarded)).toEqual({valid:true,rows:6,historyRows:guarded?8:14});
      observed.push({guarded,before,after:await read(guarded)});
    }
    expect(await page.evaluate(()=>[...window.ownedMoshResize.primary.writes,...Reflect.get(window,'ownedMoshStock').writes])).toEqual([]);
    expect(await read(null)).toEqual({valid:false,rows:null,historyRows:null});
    if(dpr===3) {
      await page.evaluate(()=>window.ownedMoshResize.primary.frame(40,1));
      await expect.poll(()=>read(true)).toEqual({valid:false,rows:null,historyRows:null});
    }
    await info.attach('closed-rendered-history',{body:JSON.stringify(observed),contentType:'application/json'});
  });
});
