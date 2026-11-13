import {type Page,type CDPSession} from '@playwright/test';
import {historyLines,mountHistory,settle} from './terminalHistory';

/** SwiftKey-shaped keyboard driven through Chromium's input-method controller: CDP is not SwiftKey, but it is Blink. */
export type Ime = {compose(text:string,region?:[number,number]):Promise<void>;commit(text:string):Promise<void>;backspace():Promise<void>;
  /** deleteSurroundingText(length, 0) with the caret at the end: it selects those characters and deletes them. */
  erase(length:number):Promise<void>;done():Promise<void>};
export async function keyboard(page:Page,pause=8):Promise<Ime> {
  const cdp:CDPSession=await page.context().newCDPSession(page);
  // Chromium brackets every composition or commit with a key 229 press; deleteSurroundingText has none.
  const bracket=async(type:'rawKeyDown'|'keyUp')=>{await cdp.send('Input.dispatchKeyEvent',{type,windowsVirtualKeyCode:229,key:'Unidentified'});};
  const settle=()=>page.waitForTimeout(pause);
  return {
    async compose(text,region){
      await bracket('rawKeyDown');
      await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length,...(region?{replacementStart:region[0],replacementEnd:region[1]}:{})});
      await bracket('keyUp');await settle();
    },
    async commit(text){await bracket('rawKeyDown');await cdp.send('Input.insertText',{text});await bracket('keyUp');await settle();},
    // The emulator's next transaction also follows the previous one by far more than a timer tick.
    async backspace(){await page.waitForTimeout(30);await bracket('rawKeyDown');await page.evaluate(()=>{document.execCommand('delete');});await bracket('keyUp');await settle();},
    async erase(length){
      await bracket('rawKeyDown');
      await page.evaluate(count=>{const area=window.ownedHistory.terminal.textarea!;area.setSelectionRange(area.value.length-count,area.value.length);document.execCommand('delete');},length);
      await bracket('keyUp');await settle();
    },
    async done(){await cdp.detach();},
  };
}
/** Types one word the way a predictive keyboard does and ends it with the separator. */
export async function typeWord(ime:Ime,word:string,separator=' ') {
  for(let end=1;end<=word.length;end++)await ime.compose(word.slice(0,end));
  await ime.commit(word+separator);
}
/** The terminal line the receiver would hold after these bytes: printable text and DEL only. */
export function line(writes:readonly string[]) {
  let text='';
  for(const data of writes.filter(data=>!data.startsWith('\x1b[<')))for(const character of data){
    if(character==='\x7f')text=text.slice(0,-1);else if(character>=' '&&character<='~')text+=character;
  }
  return text;
}
export const state=(page:Page)=>page.evaluate(()=>({
  writes:window.ownedHistory.writes,
  editor:window.ownedHistory.terminal.textarea!.value,
  skipped:document.querySelectorAll('.terminal-edit-review').length,
}));
export async function open(page:Page,mouse=false) {
  await mountHistory(page,false);
  await page.evaluate(lines=>window.ownedHistory.output(lines),historyLines(30));await settle(page);
  if(mouse){await page.evaluate(()=>window.ownedHistory.raw('\x1b[?1000h\x1b[?1006h'));await settle(page);}
  await page.evaluate(()=>window.ownedHistory.terminal.focus());
}
export const esc=(page:Page)=>page.locator('.terminal-keys button',{hasText:/^esc$/}).click();

export const swiftkeyUserAgent='Mozilla/5.0 (Linux; Android 14; SwiftKey-shaped IME fixture) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36';

/** A small deterministic generator, so a failing sequence is reproduced by its seed. */
export const random=(seed:number)=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};

/**
 * One keyboard session as the keyboard's own model of the editor: the text it believes is there and its composing
 * range. Each action is the transaction SwiftKey (web profile, from the static analysis) or a Gboard-style composing
 * keyboard sends, and it updates that model exactly as the editor must end up if every call is applied once.
 */
export class KeyboardModel {
  text='';composing:[number,number]|null=null;actions:string[]=[];
  constructor(private readonly ime:Ime,private readonly next:()=>number){}
  private get wordStart(){return this.text.search(/[a-z]*$/);}
  private word(){return Array.from({length:1+Math.floor(this.next()*5)},()=>'abcdefgh'[Math.floor(this.next()*8)]).join('');}
  private log(action:string){this.actions.push(action);}
  async letter(){const letter=this.word()[0];this.log(`commit ${letter}`);await this.ime.commit(letter);this.text+=letter;}
  /** The word is rewritten through a composing region, then the separator is its own commit or part of the composing text. */
  async wordEnd(){
    const start=this.wordStart,word=this.text.slice(start);if(!word)return this.letter();
    const separator=[' ','.',',',';'][Math.floor(this.next()*4)],inside=this.next()<0.5;
    this.log(`wordEnd ${word}${JSON.stringify(separator)} ${inside?'inside':'after'}`);
    await this.ime.compose(inside?word+separator:word,[start,this.text.length]);
    await this.ime.commit(inside?word+separator:word);
    if(!inside)await this.ime.commit(separator);
    this.text+=separator;
  }
  /** SwiftKey removes the space before a dot and commits the dot with its own space. */
  async autospace(){
    if(!this.text.endsWith(' '))return this.letter();
    this.log('autospace');await this.ime.backspace();await this.ime.commit('. ');this.text=this.text.slice(0,-1)+'. ';
  }
  async backspace(){if(!this.text)return this.letter();this.log('backspace');await this.ime.backspace();this.text=this.text.slice(0,-1);}
  async autocorrect(){
    const start=this.wordStart,word=this.text.slice(start);if(!word)return this.letter();
    const fixed=word+'x';this.log(`autocorrect ${word}>${fixed}`);
    await this.ime.compose(fixed,[start,this.text.length]);await this.ime.commit(fixed);this.text=this.text.slice(0,start)+fixed;
  }
  /** A composing keyboard erases the word it was holding (all of it), as one deleteSurroundingText, and types again. */
  async erasedWord(){
    const word=this.word(),start=this.text.length;this.log(`composeAndErase ${word}`);
    for(let end=1;end<=word.length;end++)await this.ime.compose(word.slice(0,end),end===1?undefined:[start,start+end-1]);
    await this.ime.erase(word.length);
    const again=this.word();this.log(`commit ${again}`);await this.ime.commit(again);this.text+=again;
  }
  /** SwiftKey reopens the previous word with a composing region and erases it before committing a replacement. */
  async reopenedWord(){
    const start=this.wordStart,word=this.text.slice(start);if(!word)return this.letter();
    this.log(`reopenAndErase ${word}`);await this.ime.compose(word,[start,this.text.length]);await this.ime.erase(word.length);
    const again=this.word();await this.ime.commit(again);this.text=this.text.slice(0,start)+again;
  }
  async swipe(){const word=this.word();this.log(`swipe ${word}`);await this.ime.commit(word+' ');this.text+=word+' ';}
  async step(){
    const choice=this.next();
    if(choice<0.30)return this.letter();
    if(choice<0.46)return this.wordEnd();
    if(choice<0.54)return this.autospace();
    if(choice<0.64)return this.backspace();
    if(choice<0.72)return this.autocorrect();
    if(choice<0.82)return this.erasedWord();
    if(choice<0.90)return this.reopenedWord();
    return this.swipe();
  }
}
