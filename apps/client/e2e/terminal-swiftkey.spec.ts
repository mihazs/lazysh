import {expect,test,type Page,type CDPSession} from '@playwright/test';
import {fingerDrag,historyLines,mountHistory,rowHeight,settle} from './fixtures/terminalHistory';

/**
 * SwiftKey edits the editor through InputConnection calls, derived from its shipped code (REA, 9.13.18.4):
 * typing is setComposingText(word), a unchanged word ends with finishComposingText() or commitText(), the
 * separator is its own commitText(" "), Backspace outside a word is deleteSurroundingText(1, 0), and an old
 * word is reopened with setComposingRegion + setComposingText. Chromium turns these into the DOM events
 * below; CDP drives the same Blink input-method controller (it is not SwiftKey itself).
 */
test.use({userAgent:'Mozilla/5.0 (Linux; Android 14; SwiftKey-shaped IME fixture) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'});
test.skip(({isMobile})=>!isMobile,'The soft keyboard exists on the phone project only.');
test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedHistory?.dispose());});

type Ime = {compose(text:string,region?:[number,number]):Promise<void>;commit(text:string):Promise<void>;backspace():Promise<void>;done():Promise<void>};
async function keyboard(page:Page):Promise<Ime> {
  const cdp:CDPSession=await page.context().newCDPSession(page);
  // Chromium brackets every composition or commit with a key 229 press; deleteSurroundingText has none.
  const bracket=async(type:'rawKeyDown'|'keyUp')=>{await cdp.send('Input.dispatchKeyEvent',{type,windowsVirtualKeyCode:229,key:'Unidentified'});};
  const settle=()=>page.waitForTimeout(8);
  return {
    async compose(text,region){
      await bracket('rawKeyDown');
      await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length,...(region?{replacementStart:region[0],replacementEnd:region[1]}:{})});
      await bracket('keyUp');await settle();
    },
    async commit(text){await bracket('rawKeyDown');await cdp.send('Input.insertText',{text});await bracket('keyUp');await settle();},
    // The emulator's next transaction also follows the previous one by far more than a timer tick.
    async backspace(){await page.waitForTimeout(30);await bracket('rawKeyDown');await page.evaluate(()=>{document.execCommand('delete');});await bracket('keyUp');await settle();},
    async done(){await cdp.detach();},
  };
}
/** Types one word the way a predictive keyboard does and ends it with the separator. */
async function typeWord(ime:Ime,word:string,separator=' ') {
  for(let end=1;end<=word.length;end++)await ime.compose(word.slice(0,end));
  await ime.commit(word+separator);
}
/** The terminal line the receiver would hold after these bytes: printable text and DEL only. */
function line(writes:readonly string[]) {
  let text='';
  for(const data of writes.filter(data=>!data.startsWith('\x1b[<')))for(const character of data){
    if(character==='\x7f')text=text.slice(0,-1);else if(character>=' '&&character<='~')text+=character;
  }
  return text;
}
const state=(page:Page)=>page.evaluate(()=>({
  writes:window.ownedHistory.writes,
  editor:window.ownedHistory.terminal.textarea!.value,
  skipped:document.querySelectorAll('.terminal-edit-review').length,
}));
async function open(page:Page,mouse=false) {
  await mountHistory(page,false);
  await page.evaluate(lines=>window.ownedHistory.output(lines),historyLines(30));await settle(page);
  if(mouse){await page.evaluate(()=>window.ownedHistory.raw('\x1b[?1000h\x1b[?1006h'));await settle(page);}
  await page.evaluate(()=>window.ownedHistory.terminal.focus());
}
const esc=(page:Page)=>page.locator('.terminal-keys button',{hasText:/^esc$/}).click();

/** The same fixed transactions as OwnedImeService (predictWord ... eraseOne), so the emulator case has a Chromium twin. */
test('SwiftKey-shaped transactions put exactly the typed bytes on the wire, and the erase after a toolbar key too',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  for(const typed of ['o','ow','own','owned'])await ime.compose(typed);
  await ime.commit('owned ');                       // predictWord
  await ime.commit('swipe ');                       // swipeWord
  for(const typed of ['t','te','tex','te','ten'])await ime.compose(typed);
  await ime.commit('ten ');                         // composingBackspace
  await ime.backspace();await ime.backspace();await ime.backspace();await ime.backspace();
  await ime.commit('tan ');                         // replacePrevious
  await esc(page);                                  // the emulator taps the toolbar Enter key
  await ime.backspace();                            // eraseOne
  await ime.done();
  await expect.poll(async()=>(await state(page)).writes.join('')).toBe('owned swipe ten \x7f\x7f\x7f\x7ftan \x1b\x7f');
  expect((await state(page)).skipped).toBe(0);
});

/**
 * SwiftKey's "web profile" (selected for Chromium's WEB_EDIT_TEXT editors, from static reading of its shipped code):
 * a letter is commitText(ch); a word end rewrites the word with setComposingRegion + setComposingText +
 * finishComposingText, then commitText(" "); an autocorrect is setComposingRegion + commitText(corrected word).
 */
async function typeWebWord(ime:Ime,word:string,start:number) {
  for(const letter of word)await ime.commit(letter);
  await ime.compose(word,[start,start+word.length]);   // region + composing text + finish, same word
  await ime.commit(word);
  await ime.commit(' ');
}

test('web profile: letters and word-end rewrites arrive exactly once, after a toolbar key too',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  await typeWebWord(ime,'hello',0);
  await typeWebWord(ime,'world',6);
  await esc(page);
  await typeWebWord(ime,'ls',12);
  await ime.done();
  await expect.poll(async()=>line((await state(page)).writes)).toBe('hello world ls ');
  expect((await state(page)).skipped).toBe(0);
});

test('web profile: an autocorrect of a word typed before a toolbar key is held, never duplicated',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  for(const letter of 'wrold')await ime.commit(letter);
  await esc(page);
  await ime.compose('wrold',[0,5]);                    // region over text the toolbar key made unowned
  await ime.commit('world');await ime.commit(' ');
  await ime.done();
  // The correction is held for review and the typo stays; the separator after it may or may not be sent, but nothing is repeated.
  await expect(page.locator('.terminal-edit-review')).toHaveCount(1);
  expect(line((await state(page)).writes)).toMatch(/^wrold ?$/);
});

test('web profile: Backspace inside a word and after the separator is one DEL each, even after a scroll',async({page})=>{
  await open(page,true);
  const ime=await keyboard(page);
  for(const letter of 'helo')await ime.commit(letter);
  await ime.backspace();await ime.commit('l');await ime.commit('o');
  await ime.compose('hello',[0,5]);await ime.commit('hello');await ime.commit(' ');
  const box=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!;
  await fingerDrag(page,{x:box.x+box.width/2,y:box.y+box.height/4},await rowHeight(page),3);
  await ime.backspace();
  await ime.done();
  await expect.poll(async()=>line((await state(page)).writes)).toBe('hello');
  expect((await state(page)).skipped).toBe(0);
});

test('Backspace after a toolbar key still erases on the terminal instead of being skipped',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  await typeWord(ime,'status');
  await esc(page);
  await ime.backspace();
  await ime.done();
  await expect.poll(async()=>line((await state(page)).writes)).toBe('status');
  const seen=await state(page);
  // Esc is the only key between the typed text and the erase; the erase is one DEL, not a skipped edit.
  expect(seen.writes,JSON.stringify(seen)).toEqual(['status ','\x1b','\x7f']);
  expect(seen.skipped).toBe(0);
  expect(line(seen.writes)).toBe('status');
});

/** A mouse-tracking app (Herdr, an agent TUI) with a misspelled word typed and the keyboard still open. */
async function typedWithMouseTracking(page:Page) {
  await open(page,true);
  const ime=await keyboard(page);
  await typeWord(ime,'wrold');
  return {ime,box:(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!};
}
/** SwiftKey removes the separator, reopens the misspelled word and replaces it with the suggestion. */
async function correctToWorld(ime:Ime) {
  await ime.backspace();
  await ime.compose('wrold',[0,5]);
  await ime.commit('world ');
  await ime.done();
}

test('correcting the previous word still works after the app was scrolled with the wheel',async({page})=>{
  const {ime,box}=await typedWithMouseTracking(page);
  await fingerDrag(page,{x:box.x+box.width/2,y:box.y+box.height/4},await rowHeight(page),4);
  await expect.poll(()=>page.evaluate(()=>window.ownedHistory.writes.filter(data=>data.startsWith('\x1b[<64;')).length)).toBeGreaterThan(0);
  await correctToWorld(ime);
  await expect.poll(async()=>line((await state(page)).writes)).toBe('world ');
  const seen=await state(page);
  expect(seen.skipped,JSON.stringify(seen)).toBe(0);
});

test('a tap that moves the app cursor still fences the previous word from a stale correction',async({page})=>{
  const {ime,box}=await typedWithMouseTracking(page);
  await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/3);
  await expect.poll(()=>page.evaluate(()=>window.ownedHistory.writes.some(data=>data.startsWith('\x1b[<0;')))).toBe(true);
  await correctToWorld(ime);
  // The click may have moved the cursor in the app: a replacement is reviewed, not guessed.
  await expect(page.locator('.terminal-edit-review')).toHaveCount(1);
  expect(line((await state(page)).writes)).not.toContain('world');
});

test('erasing Unicode text typed before a toolbar key is still held for review, never guessed',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  await ime.commit('né ');
  await esc(page);
  await ime.backspace();                       // the separator: ASCII, one DEL
  await ime.backspace();                       // é: the remote erase unit is unknown
  await ime.done();
  await expect(page.locator('.terminal-edit-review')).toHaveCount(1);
  expect((await state(page)).writes).toEqual(['né ','\x1b','\x7f']);
});
