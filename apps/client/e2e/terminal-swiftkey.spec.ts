import {expect,test,type Page} from '@playwright/test';
import {fingerDrag,rowHeight} from './fixtures/terminalHistory';
import {esc,keyboard,line,open,state,typeWord,type Ime} from './fixtures/swiftkeyKeyboard';
import {recordedTraces,type RecordedEvent} from './fixtures/swiftkeyTraces';

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

/**
 * Found on an Android 13 WebView with a scripted keyboard (#1505): when deleteSurroundingText erases all of a composing
 * word, Chromium drops the composition and sends no compositionend. The bridge kept waiting for that event, swallowed every
 * later insertion, and only a key event (Backspace) flushed what the keyboard believed it had typed.
 */
test('a composing word the keyboard erases whole does not swallow the characters and the dot after it',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  await ime.commit('hi ');
  await ime.compose('ls');await ime.erase(2);          // the keyboard drops its pending word...
  await ime.commit('ls');await ime.commit('.');await ime.commit(' ');await ime.commit('x');
  await expect.poll(async()=>line((await state(page)).writes)).toBe('hi ls. x');
  await ime.backspace();                                 // ...and Backspace is one DEL of what the terminal holds
  await ime.done();
  await expect.poll(async()=>line((await state(page)).writes)).toBe('hi ls. ');
  const seen=await state(page);
  expect(seen.editor).toBe('hi ls. ');
  expect(seen.skipped,JSON.stringify(seen)).toBe(0);
});

test('a word reopened by a composing region and erased whole is replaced once, then typing continues',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  for(const letter of 'hello')await ime.commit(letter);
  await ime.compose('hello',[0,5]);await ime.erase(5);  // setComposingRegion over the word, then deleteSurroundingText(5, 0)
  await ime.commit('hallo');await ime.commit('.');await ime.commit('z');
  await ime.done();
  await expect.poll(async()=>line((await state(page)).writes)).toBe('hallo.z');
  expect((await state(page)).editor).toBe('hallo.z');
});

/** Dots in the web profile: a word end, a punctuation that carries its own space, the autospace that removes the space first. */
test('web profile: a dot after a word, with the autospace rewrite, arrives once and Backspace erases one character',async({page})=>{
  await open(page);
  const ime=await keyboard(page);
  await typeWebWord(ime,'ls',0);                        // "ls "
  await ime.backspace();await ime.commit('. ');         // SwiftKey removes the space before a dot and commits ". "
  await typeWebWord(ime,'la',4);                        // "ls. la "
  await ime.backspace();await ime.commit('.');await ime.commit('txt');
  await ime.backspace();
  await ime.done();
  await expect.poll(async()=>line((await state(page)).writes)).toBe('ls. la.tx');
  const seen=await state(page);
  expect(seen.editor).toBe('ls. la.tx');
  expect(seen.skipped,JSON.stringify(seen)).toBe(0);
});

/** Replays DOM events recorded on a real Android WebView, with the textarea values they were recorded with. */
async function replay(page:Page,events:readonly RecordedEvent[]) {
  await page.evaluate(async (recorded:RecordedEvent[])=>{
    const area=window.ownedHistory.terminal.textarea!,pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
    for(const [type,inputType,data,isComposing,value,start,end,gap] of recorded){
      await pause(gap?30:0);
      if(type==='keydown'||type==='keyup')area.dispatchEvent(new KeyboardEvent(type,{key:'Unidentified',keyCode:229,isComposing,bubbles:true,composed:true,cancelable:true}));
      else if(type.startsWith('composition'))area.dispatchEvent(new CompositionEvent(type,{data:data??'',bubbles:true,composed:true}));
      else {
        if(type==='input'){area.value=value!;area.setSelectionRange(start!,end!);}
        area.dispatchEvent(new InputEvent(type,{inputType,data,isComposing,bubbles:true,composed:true,cancelable:type==='beforeinput'}));
      }
    }
    await pause(30);
  },[...events]);
}
for(const [name,trace] of Object.entries(recordedTraces))
  test(`recorded Android WebView trace ${name} (${trace.calls}) puts exactly the typed line on the wire`,async({page})=>{
    await open(page);
    await replay(page,trace.events);
    await expect.poll(async()=>line((await state(page)).writes)).toBe(trace.line);
    const seen=await state(page);
    expect(seen.editor).toBe(trace.line);
    expect(seen.skipped,JSON.stringify(seen)).toBe(0);
  });
