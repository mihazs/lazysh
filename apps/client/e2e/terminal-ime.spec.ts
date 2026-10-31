import {expect,test,type Page,type BrowserContext} from '@playwright/test';
import type {mountTerminalImeHarness} from './fixtures/TerminalImeHarness';
declare global {interface Window {ownedIme:ReturnType<typeof mountTerminalImeHarness>}}

async function commitNativeComposition(page:Page,context:BrowserContext,text:string) {
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});
  await cdp.send('Input.insertText',{text});
  await cdp.detach();
}

test.use({userAgent:'Mozilla/5.0 (Linux; Android 14; Owned IME fixture) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'});
test.beforeEach(async({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{const fixture=await import('/e2e/fixtures/TerminalImeHarness.ts');window.ownedIme=fixture.mountTerminalImeHarness();});
});

for(const text of ['你好','👩🏽‍💻'])test(`ordinary IME completion preserves repeated ${text} transactions`,async({page})=>{
  const writes=await page.evaluate(async text=>{
    const area=window.ownedIme.textarea;
    for(let transaction=0;transaction<2;transaction++){
      const prefix=area.value;
      area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,composed:true}));
      area.value=prefix+text;area.setSelectionRange(area.value.length,area.value.length);
      area.dispatchEvent(new CompositionEvent('compositionupdate',{data:text,bubbles:true,composed:true}));
      await new Promise(resolve=>setTimeout(resolve,10));
      area.dispatchEvent(new CompositionEvent('compositionend',{data:text,bubbles:true,composed:true}));
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    return window.ownedIme.writes;
  },text);
  expect(writes).toEqual([text,text]);
});

test('hardware input preserves identical consecutive commands',async({page})=>{
  await page.keyboard.type('owned');await page.keyboard.press('Enter');
  await page.keyboard.type('owned');await page.keyboard.press('Enter');
  expect(await page.evaluate(()=>window.ownedIme.writes.join(''))).toBe('owned\rowned\r');
});

test('Android key229 autocorrection replaces the synthetic active word once',async({page})=>{
  await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    const edit=async(value:string,data:string,inputType:string)=>{
      area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
      area.value=value;area.setSelectionRange(value.length,value.length);
      area.dispatchEvent(new InputEvent('input',{data,inputType,bubbles:true,composed:true}));
      await new Promise(resolve=>setTimeout(resolve,10));
    };
    await edit('teh','teh','insertText');
    await edit('the','the','insertReplacementText');
  });
  const writes=await page.evaluate(()=>window.ownedIme.writes);
  let remote='';for(const character of writes.join(''))remote=character==='\x7f'?remote.slice(0,-1):remote+character;
  expect(remote,JSON.stringify({writes})).toBe('the');
  await page.keyboard.press('Enter');
  await test.info().attach('owned-ime-wire',{body:JSON.stringify({writes:await page.evaluate(()=>window.ownedIme.writes)}),contentType:'application/json'});
});

test('Android composition completion after Enter does not replay the previous synthetic command',async({page})=>{
  await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,composed:true}));
    area.value='owned';
    area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'owned',bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,10));
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,composed:true,cancelable:true}));
    // A late IME DOM commit completes the original composing range after keydown cleared it.
    area.value='owned';
    area.dispatchEvent(new CompositionEvent('compositionend',{data:'owned',bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,10));
  });
  const writes=await page.evaluate(()=>window.ownedIme.writes);
  expect(writes.join(''),JSON.stringify({writes})).toBe('owned\r');
});

test('a canceled composition cannot replay after blur',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    area.value='old';area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'old',bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,10));
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true}));
    area.dispatchEvent(new FocusEvent('blur',{bubbles:false}));
    area.value='old';area.dispatchEvent(new CompositionEvent('compositionend',{data:'old',bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  });
  expect(writes).toEqual([]);
});

for(const keydown of [true,false])test(`owned ASCII edits grow, shrink and repeat with key229=${keydown}`,async({page})=>{
  const writes=await page.evaluate(async keydown=>{
    const area=window.ownedIme.textarea;
    for(const [value,data,inputType] of [['teh','teh','insertText'],['the','the','insertReplacementText'],['there','there','insertReplacementText'],['the','the','insertReplacementText'],['thethe','the','insertText']]){
      if(keydown)area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
      area.dispatchEvent(new InputEvent('beforeinput',{data,inputType,bubbles:true,composed:true}));
      area.value=value;area.setSelectionRange(value.length,value.length);
      area.dispatchEvent(new InputEvent('input',{data,inputType,bubbles:true,composed:true}));
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    return window.ownedIme.writes;
  },keydown);
  const remote:string[]=[];for(const character of writes.join('')){if(character==='\x7f')remote.pop();else remote.push(character);}
  expect(remote.join(''),JSON.stringify({writes})).toBe('thethe');
});

test('Enter uses the final DOM commit, repeated Enter/end do not replay, and a next composition is independent',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    area.value='teh';area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'teh',bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,5));
    for(let count=0;count<2;count++)area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true}));
    area.value='the';area.dispatchEvent(new CompositionEvent('compositionend',{data:'the',bubbles:true}));
    area.dispatchEvent(new CompositionEvent('compositionend',{data:'the',bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,5));
    area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    area.value='the';area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'the',bubbles:true}));
    area.dispatchEvent(new CompositionEvent('compositionend',{data:'the',bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,5));
    return window.ownedIme.writes;
  });
  expect(writes.join(''),JSON.stringify({writes})).toBe('the\rthe');
});

test('consecutive compositions before the commit timer preserve both legitimate messages',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    for(const text of ['你好','👩🏽‍💻']){
      const prefix=area.value;
      area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      area.value=prefix+text;
      area.dispatchEvent(new CompositionEvent('compositionupdate',{data:text,bubbles:true}));
      area.dispatchEvent(new CompositionEvent('compositionend',{data:text,bubbles:true}));
    }
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  });
  expect(writes.join(''),JSON.stringify({writes})).toBe('你好👩🏽‍💻');
});

test('hardware control commits preedit once and clears ownership before late end',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    area.value='owned';area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'owned',bubbles:true}));
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',code:'ArrowLeft',keyCode:37,bubbles:true,cancelable:true}));
    area.dispatchEvent(new CompositionEvent('compositionend',{data:'owned',bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  });
  expect(writes.join(''),JSON.stringify({writes})).toBe('owned\x1b[D');
});

test('unknown xterm helper shape keeps ordinary upstream keyboard behavior',async({page})=>{
  await page.evaluate(async()=>{
    window.ownedIme.dispose();
    const fixture=await import('/e2e/fixtures/TerminalImeHarness.ts');window.ownedIme=fixture.mountTerminalImeHarness(true);
  });
  await page.keyboard.type('owned');await page.keyboard.press('Enter');
  expect(await page.evaluate(()=>window.ownedIme.writes.join(''))).toBe('owned\r');
  expect(await page.evaluate(()=>{window.ownedIme.observation.dispose();return window.ownedIme.textarea.getAttribute('autocomplete');})).toBeNull();
});

test('non-ASCII replacement keeps upstream handling without inventing unsafe erasure',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    for(const value of ['éx','èy']){
      await window.ownedIme.replace(value);
    }
    return window.ownedIme.writes;
  });
  expect(writes).toEqual(['éx','èy']);
  expect(writes.join('')).not.toContain('\x7f');
});

test('protocol output between compositionend and commit does not consume the input owner',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const {textarea:area,terminal}=window.ownedIme;
    area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    area.value='owned';area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'owned',bubbles:true}));
    area.dispatchEvent(new CompositionEvent('compositionend',{data:'owned',bubbles:true}));
    terminal.input('synthetic-protocol-reply',false);
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  });
  expect(writes).toEqual(['synthetic-protocol-reply','owned']);
});

for(const boundary of ['reset','dispose','flush'] as const)test(`pending Enter is fenced by ${boundary} without duplicate input`,async({page})=>{
  const writes=await page.evaluate(async boundary=>{
    const {textarea:area,observation}=window.ownedIme;
    area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    area.value='owned';area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'owned',bubbles:true}));
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true}));
    area.dispatchEvent(new CompositionEvent('compositionend',{data:'owned',bubbles:true}));
    observation[boundary]();
    if(boundary==='flush')observation.flush();
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  },boundary);
  expect(writes).toEqual(boundary==='flush'?['owned']:[]);
});

test('a non-user protocol reply does not surrender the editable ASCII suffix',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const {textarea:area,terminal}=window.ownedIme;
    for(const value of ['teh','the']){
      await window.ownedIme.replace(value);
      if(value==='teh')terminal.input('synthetic-protocol-reply',false);
    }
    return window.ownedIme.writes;
  });
  expect(writes).toEqual(['teh','synthetic-protocol-reply','\x7f\x7fhe']);
});

test('hardware command boundary prevents a new correction from erasing the previous command',async({page})=>{
  await page.keyboard.type('owned');await page.keyboard.press('Enter');
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    for(const value of ['teh','the']){
      await window.ownedIme.replace(value);
    }
    return window.ownedIme.writes;
  });
  expect(writes.join('')).toBe('owned\rteh\x7f\x7fhe');
});

test('an edit after cursor movement retains upstream fallback instead of silently dropping text',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    for(const value of ['teh','the']){
      await window.ownedIme.replace(value);
      if(value==='teh')area.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',code:'ArrowLeft',keyCode:37,bubbles:true,cancelable:true}));
    }
    return window.ownedIme.writes;
  });
  expect(writes).toEqual(['teh','\x1b[D','the']);
});

test('a changed DOM baseline keeps the intercepted key229 fallback instead of losing its edit',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    area.value='foreign';area.setSelectionRange(7,7);
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.dispatchEvent(new InputEvent('beforeinput',{data:'updated',inputType:'insertReplacementText',bubbles:true,composed:true}));
    area.value='updated';area.setSelectionRange(7,7);
    area.dispatchEvent(new InputEvent('input',{data:'updated',inputType:'insertReplacementText',bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,5));
    return window.ownedIme.writes;
  });
  expect(writes).toEqual(['updated']);
});

for(const boundary of ['reset','another focused control'] as const)test(`native CDP composition cannot commit into a revoked editor after ${boundary}`,async({page,context})=>{
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'owned',selectionStart:5,selectionEnd:5});
  await page.evaluate(boundary=>{
    if(boundary==='reset')window.ownedIme.observation.reset();
    else {const button=document.createElement('button');button.textContent='Owned focus boundary';document.body.append(button);button.focus();}
  },boundary);
  await cdp.send('Input.insertText',{text:'owned'});
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual([]);
  expect(await page.evaluate(()=>window.ownedIme.textarea.readOnly)).toBe(true);
  await page.evaluate(()=>window.ownedIme.terminal.input('synthetic-protocol-reply',false));
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual(['synthetic-protocol-reply']);
  await cdp.detach();
});

test('a newly focused editor preserves explicit key229-absent native input after revocation',async({page,context})=>{
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'old',selectionStart:3,selectionEnd:3});
  await page.evaluate(()=>{window.ownedIme.observation.reset();window.ownedIme.observation.resume();window.ownedIme.terminal.focus();});
  // CDP targets the newly focused editor; it cannot represent an old Android InputConnection.
  await cdp.send('Input.insertText',{text:'new 👩🏽‍💻'});
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual(['new 👩🏽‍💻']);
  await cdp.detach();
});

test('foreground eligibility returning alone does not revive a revoked native composition editor',async({page,context})=>{
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'old',selectionStart:3,selectionEnd:3});
  await page.evaluate(()=>window.ownedIme.setAcceptsInput(false));
  await cdp.send('Input.insertText',{text:'old'});
  await page.evaluate(()=>window.ownedIme.setAcceptsInput(true));
  await cdp.send('Input.insertText',{text:'old'});
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual([]);
  expect(await page.evaluate(()=>window.ownedIme.textarea.readOnly)).toBe(true);
  await page.locator('.xterm-screen').click({position:{x:12,y:12}});
  expect(await page.evaluate(()=>window.ownedIme.textarea.readOnly)).toBe(false);
  await cdp.send('Input.insertText',{text:'old'});
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual(['old']);
  await cdp.detach();
});

test('observer disposal restores original readonly state and a rebound editor accepts new native input',async({page,context})=>{
  const states=await page.evaluate(async()=>{
    const {terminal,textarea:area,observation,writes}=window.ownedIme;
    observation.reset();observation.dispose();
    const restored=area.readOnly,completionRestored=area.getAttribute('autocomplete');
    const {observeTerminalInput}=await import('/src/terminal.ts');
    area.readOnly=true;area.setAttribute('autocomplete','on');
    const readonly=observeTerminalInput(terminal,data=>writes.push(data));
    readonly.reset();readonly.resume();const retained=area.readOnly,completionActive=area.getAttribute('autocomplete');readonly.dispose();const disposed=area.readOnly,completionDisposed=area.getAttribute('autocomplete');
    area.readOnly=false;area.removeAttribute('autocomplete');
    window.ownedIme.observation=observeTerminalInput(terminal,data=>writes.push(data));
    window.ownedIme.observation.resume();terminal.focus();
    return {restored,retained,disposed,completionRestored,completionActive,completionDisposed};
  });
  expect(states).toEqual({restored:false,retained:true,disposed:true,completionRestored:null,completionActive:'off',completionDisposed:'on'});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.insertText',{text:'rebound'});
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual(['rebound']);
  await cdp.detach();
});

test('revoked unsupported-edit fallback cannot emit after the editor is explicitly resumed',async({page})=>{
  const writes=await page.evaluate(async()=>{
    await window.ownedIme.replace('éx');
    const {textarea:area,observation,terminal}=window.ownedIme;
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.value='èy';area.setSelectionRange(area.value.length,area.value.length);
    area.dispatchEvent(new InputEvent('input',{data:'èy',inputType:'insertReplacementText',bubbles:true,composed:true}));
    observation.reset();observation.resume();terminal.focus();
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  });
  expect(writes).toEqual(['éx']);
});

for(const [value,inputType,expected] of [['é','insertReplacementText','\x7f'],['👩🏽‍💻','insertReplacementText','👩🏽‍💻'],['owned paste','insertFromPaste','owned paste']] as const)test(`owned fallback retains pinned upstream policy for ${inputType} ${value}`,async({page})=>{
  const writes=await page.evaluate(async({value,inputType})=>{
    if(inputType!=='insertFromPaste')await window.ownedIme.replace('éx');
    const area=window.ownedIme.textarea;
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.value=value;area.setSelectionRange(value.length,value.length);
    area.dispatchEvent(new InputEvent('input',{data:value,inputType,bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  },{value,inputType});
  expect(writes).toEqual(inputType==='insertFromPaste'?[expected]:['éx',expected]);
});

test('native composition replacing an owned committed ASCII range edits the original word',async({page,context})=>{
  await page.evaluate(async()=>{await window.ownedIme.replace('teh');window.ownedIme.textarea.setSelectionRange(0,3);});
  await commitNativeComposition(page,context,'the');
  const writes=await page.evaluate(()=>window.ownedIme.writes);
  const remote:string[]=[];for(const character of writes.join('')){if(character==='\x7f')remote.pop();else remote.push(character);}
  expect(remote.join(''),JSON.stringify({writes})).toBe('the');
  await page.keyboard.press('Enter');
  await test.info().attach('owned-native-range-wire',{body:JSON.stringify({writes:await page.evaluate(()=>window.ownedIme.writes)}),contentType:'application/json'});
});

for(const [initial,replacement,cursor] of [['éx','èy',false],['teh','the',true]] as const)test(`native selected-range composition keeps unsupported erasure bounded after cursor=${cursor} ${initial}`,async({page,context})=>{
  await page.evaluate(initial=>window.ownedIme.replace(initial),initial);
  if(cursor)await page.keyboard.press('ArrowLeft');
  await page.evaluate(()=>window.ownedIme.textarea.select());
  await commitNativeComposition(page,context,replacement);
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual(cursor?[initial,'\x1b[D']:[initial]);
});

test.describe('Mac platform contract',()=>{
  test.use({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'});
for(const macOptionIsMeta of [false,true])for(const screenReaderMode of [false,true])test(`Mac platform native composition and controls keep macOptionIsMeta=${macOptionIsMeta} screenReaderMode=${screenReaderMode}`,async({page,context})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'platform',{value:'MacIntel'}));
  await page.reload();
  const configuration=await page.evaluate(async options=>{
    const {mountTerminalImeHarness}=await import('/e2e/fixtures/TerminalImeHarness.ts');
    window.ownedIme=mountTerminalImeHarness(false,options);
    return {mac:(window.ownedIme.terminal as unknown as {_core:{browser:{isMac:boolean}}})._core.browser.isMac,screenReaderMode:window.ownedIme.terminal.options.screenReaderMode,macOptionIsMeta:window.ownedIme.terminal.options.macOptionIsMeta};
  },{macOptionIsMeta,screenReaderMode});
  expect(configuration).toEqual({mac:true,macOptionIsMeta,screenReaderMode});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'你好',selectionStart:2,selectionEnd:2});
  await cdp.send('Input.insertText',{text:'你好'});
  await expect.poll(()=>page.evaluate(()=>window.ownedIme.writes.join(''))).toBe('你好');
  await page.keyboard.press('Enter');
  await page.keyboard.type('c');
  await page.keyboard.press('Alt+x');
  // Chromium emulates key events, not macOS layout conversion; provide its native text commit explicitly.
  if(!macOptionIsMeta)await cdp.send('Input.insertText',{text:'≈'});
  expect(await page.evaluate(()=>window.ownedIme.writes.join(''))).toBe(`你好\rc${macOptionIsMeta?'\x1bx':'≈'}`);
  await cdp.detach();
});

});


test('sustained software messages keep a long owned context without replaying it after Enter',async({page,context})=>{
  const prefix='Inspect the owned workspace and report progress. '.repeat(12);
  for(let message=0;message<3;message++){
    await commitNativeComposition(page,context,prefix);
    await expect.poll(()=>page.evaluate(()=>window.ownedIme.textarea.value.length)).toBe(prefix.length);
    expect(prefix.length).toBeGreaterThan(512);
    await commitNativeComposition(page,context,'teh');
    await page.evaluate(()=>{const area=window.ownedIme.textarea;area.setSelectionRange(area.value.length-3,area.value.length);});
    await commitNativeComposition(page,context,'the');
    await expect.poll(()=>page.evaluate(()=>window.ownedIme.textarea.value)).toBe(prefix+'the');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(()=>window.ownedIme.textarea.value)).toBe('');
  }
  const writes=await page.evaluate(()=>window.ownedIme.writes);
  const remote:string[]=[];for(const character of writes.join('')){if(character==='\x7f')remote.pop();else remote.push(character);}
  expect(remote.join(''),JSON.stringify({writes})).toBe((prefix+'the\r').repeat(3));
});
