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

for(const inputType of ['insertReplacementText','insertCompositionText'])test(`unapplied combining correction sends no replay or guessed erasure for ${inputType}`,async({page})=>{
  const writes=await page.evaluate(async inputType=>{
    await window.ownedIme.replace('éx');await window.ownedIme.replace('èy',inputType);
    return window.ownedIme.writes;
  },inputType);
  expect(writes,JSON.stringify({writes})).toEqual(['éx']);
  expect(await page.evaluate(()=>window.ownedIme.proposal)).toEqual({text:'èy',truncated:false});
});

test('owned non-tail ASCII correction preserves editable context',async({page})=>{
  const result=await page.evaluate(async()=>{
    const owner=window.ownedIme;
    await owner.replace('teh tail');
    for(const [text,cursor] of [['the tail',3],['there tail',5],['the tail',3],['the the tail',7]] as const)
      await owner.replace(text,'insertReplacementText',cursor);
    let remote='';
    for(const character of owner.writes.join(''))remote=character==='\x7f'?remote.slice(0,-1):remote+character;
    return {remote,proposal:owner.proposal,readOnly:owner.textarea.readOnly};
  });
  expect(result).toEqual({remote:'the the tail',proposal:null,readOnly:false});
});

test('unapplied native Unicode correction does not submit a deferred Enter',async({page,context})=>{
  await page.evaluate(async()=>{await window.ownedIme.replace('éx');window.ownedIme.textarea.select();});
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'èy',selectionStart:3,selectionEnd:3});
  await page.evaluate(()=>window.ownedIme.textarea.dispatchEvent(new KeyboardEvent('keydown',{
    key:'Enter',code:'Enter',keyCode:13,bubbles:true,composed:true,cancelable:true,
  })));
  await cdp.send('Input.insertText',{text:'èy'});
  await cdp.detach();
  await page.waitForTimeout(20);
  const writes=await page.evaluate(()=>window.ownedIme.writes);
  expect(writes,JSON.stringify({writes})).toEqual(['éx']);
});

for(const boundary of ['reset','dispose'] as const)test(`unapplied context is cleared at the ${boundary} lifetime boundary`,async({page})=>{
  const result=await page.evaluate(async boundary=>{
    const owner=window.ownedIme;
    await owner.replace('éx');await owner.replace('èy');
    const before=owner.proposal;
    owner.observation[boundary]();
    return {before,after:owner.proposal,writes:owner.writes};
  },boundary);
  expect(result).toEqual({before:{text:'èy',truncated:false},after:null,writes:['éx']});
});

test('unapplied review blur retains context, blocks user input and preserves protocol until explicit dismissal',async({page,context})=>{
  await page.evaluate(async()=>{
    const owner=window.ownedIme;
    await owner.replace('éx');await owner.replace('èy');
    owner.textarea.blur();owner.observation.resume();
    owner.terminal.input('stale-user-commit',true);
    owner.terminal.input('protocol-reply',false);
  });
  expect(await page.evaluate(()=>({proposal:window.ownedIme.proposal,readOnly:window.ownedIme.textarea.readOnly,writes:window.ownedIme.writes})))
    .toEqual({proposal:{text:'èy',truncated:false},readOnly:true,writes:['éx','protocol-reply']});
  await page.evaluate(()=>{window.ownedIme.observation.dismiss();window.ownedIme.terminal.focus();});
  const cdp=await context.newCDPSession(page);await cdp.send('Input.insertText',{text:'new'});await cdp.detach();
  expect(await page.evaluate(()=>({proposal:window.ownedIme.proposal,writes:window.ownedIme.writes})))
    .toEqual({proposal:null,writes:['éx','protocol-reply','new']});
});

test('direct unapplied dismissal retires the focused readonly editor before fresh typing',async({page,context})=>{
  const boundary=await page.evaluate(async()=>{
    const owner=window.ownedIme;
    await owner.replace('éx');await owner.replace('èy');
    const focused=document.activeElement===owner.textarea;
    let blurs=0;owner.textarea.addEventListener('blur',()=>blurs++,{once:true});
    owner.observation.dismiss();
    return {focused,blurs,readOnly:owner.textarea.readOnly,stillFocused:document.activeElement===owner.textarea,proposal:owner.proposal};
  });
  expect(boundary).toEqual({focused:true,blurs:1,readOnly:false,stillFocused:false,proposal:null});
  await page.evaluate(()=>window.ownedIme.terminal.focus());
  const cdp=await context.newCDPSession(page);await cdp.send('Input.insertText',{text:'fresh'});await cdp.detach();
  expect(await page.evaluate(()=>window.ownedIme.writes)).toEqual(['éx','fresh']);
});

test('unapplied context is bounded without splitting a supplementary character',async({page})=>{
  const result=await page.evaluate(async()=>{
    await window.ownedIme.replace('éx');await window.ownedIme.replace('x'.repeat(65535)+'👩tail');
    const proposal=window.ownedIme.proposal;
    return {length:proposal?.text.length,truncated:proposal?.truncated,last:proposal?.text.slice(-1),writes:window.ownedIme.writes};
  });
  expect(result).toEqual({length:65535,truncated:true,last:'x',writes:['éx']});
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

test('an edit after cursor movement retains unapplied context without replay',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const area=window.ownedIme.textarea;
    for(const value of ['teh','the']){
      await window.ownedIme.replace(value);
      if(value==='teh')area.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',code:'ArrowLeft',keyCode:37,bubbles:true,cancelable:true}));
    }
    return window.ownedIme.writes;
  });
  expect(writes).toEqual(['teh','\x1b[D']);
  expect(await page.evaluate(()=>window.ownedIme.proposal)).toEqual({text:'the',truncated:false});
});

test('a changed DOM baseline retains the intercepted edit for review without replay',async({page})=>{
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
  expect(writes).toEqual([]);
  expect(await page.evaluate(()=>window.ownedIme.proposal)).toEqual({text:'updated',truncated:false});
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

for(const [value,inputType,expected] of [['é','insertReplacementText','\x7f'],['👩🏽‍💻','insertReplacementText','👩🏽‍💻'],['owned paste','insertFromPaste','owned paste']] as const)test(`unapplied corrections preserve literal paste for ${inputType} ${value}`,async({page})=>{
  const writes=await page.evaluate(async({value,inputType})=>{
    if(inputType!=='insertFromPaste')await window.ownedIme.replace('éx');
    const area=window.ownedIme.textarea;
    area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.value=value;area.setSelectionRange(value.length,value.length);
    area.dispatchEvent(new InputEvent('input',{data:value,inputType,bubbles:true,composed:true}));
    await new Promise(resolve=>setTimeout(resolve,10));
    return window.ownedIme.writes;
  },{value,inputType});
  expect(writes).toEqual(inputType==='insertFromPaste'?[expected]:value==='é'?['éx',expected]:['éx']);
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

for(const [inputType,initial,replacement,typed,final] of [
  ['insertCompositionText','teh','the','The tail','The the tail'],
  ['insertFromPaste','teh','the tail','The tail','The the tail'],
  ['deleteContentForward','abc def','abc ','ABC more','ABC '],
] as const)test(`owned fallback ${inputType} preserves exact edits and the next editable suffix`,async({page})=>{
  await page.evaluate(initial=>window.ownedIme.replace(initial),initial);
  const read=()=>page.evaluate(()=>{const o=window.ownedIme;let remote='';for(const c of o.writes.join(''))remote=c==='\x7f'?remote.slice(0,-1):remote+c;return {remote,proposal:o.proposal,readOnly:o.textarea.readOnly,sends:o.writes.length};});
  await page.evaluate(({replacement,inputType})=>window.ownedIme.replace(replacement,inputType,0),{replacement,inputType});
  expect(await read()).toEqual({remote:replacement,proposal:null,readOnly:false,sends:2});
  await page.evaluate(typed=>window.ownedIme.replace(typed,'insertReplacementText',0),typed);
  expect(await read()).toEqual({remote:typed,proposal:null,readOnly:false,sends:3});
  await page.evaluate(({final,inputType})=>window.ownedIme.replace(final,inputType,0),{final,inputType});
  expect(await read()).toEqual({remote:final,proposal:null,readOnly:false,sends:4});
});

for(const barrier of ['blur','reset','access','replacement'] as const)test(`pending owned fallback retires before ${barrier} and fresh input`,async({page})=>{
  const result=await page.evaluate(async barrier=>{
    const o=window.ownedIme;await o.replace('old');const staleWrites=o.writes;
    const area=o.textarea;area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
    area.value='new';area.setSelectionRange(0,0);area.dispatchEvent(new InputEvent('input',{inputType:'insertCompositionText',data:'new',bubbles:true,composed:true}));
    if(barrier==='replacement'){o.dispose();const {mountTerminalImeHarness}=await import('/e2e/fixtures/TerminalImeHarness.ts');window.ownedIme=mountTerminalImeHarness();}
    else if(barrier==='access')o.setAcceptsInput(false);
    else if(barrier==='reset')o.observation.reset();else area.blur();
    await new Promise(resolve=>setTimeout(resolve,10));const afterRetirement=[...staleWrites];
    if(barrier!=='replacement'){if(barrier==='access')o.setAcceptsInput(true);o.observation.resume();o.terminal.focus();}
    await window.ownedIme.replace('fresh');
    return {afterRetirement,oldWrites:[...staleWrites],freshWrites:[...window.ownedIme.writes],replaced:window.ownedIme.terminal!==o.terminal};
  },barrier);
  expect(result.afterRetirement).toEqual(['old']);expect(result.replaced).toBe(barrier==='replacement');
  expect(result.oldWrites).toEqual(barrier==='replacement'?['old']:['old','fresh']);
  expect(result.freshWrites).toEqual(barrier==='replacement'?['fresh']:['old','fresh']);
});

test('unknown edits without key229 keep the upstream fallback boundary',async({page})=>{
  const writes=await page.evaluate(async()=>{const o=window.ownedIme;await o.replace('owned');o.textarea.value='other';o.textarea.dispatchEvent(new InputEvent('input',{inputType:'insertCompositionText',data:'other',bubbles:true,composed:true}));await new Promise(resolve=>setTimeout(resolve,10));return o.writes;});
  expect(writes).toEqual(['owned']);
});

test('beforeinput and the next key229 flush each pending fallback exactly once',async({page})=>{
  const writes=await page.evaluate(async()=>{
    const o=window.ownedIme;await o.replace('teh');const area=o.textarea;
    for(const [value,inputType]of [['the','insertCompositionText'],['there','insertText'],['there the','insertCompositionText']]){
      area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
      area.dispatchEvent(new InputEvent('beforeinput',{inputType,data:value,bubbles:true,composed:true,cancelable:true}));
      area.value=value;area.setSelectionRange(0,0);area.dispatchEvent(new InputEvent('input',{inputType,data:value,bubbles:true,composed:true}));
    }
    await new Promise(resolve=>setTimeout(resolve,10));return o.writes;
  });
  expect(writes).toEqual(['teh','\x7f\x7fhe','re',' the']);
});


test('forward deletion without key229 keeps owned suggestions and subsequent typing in sync',async({page,context})=>{
  await commitNativeComposition(page,context,'abc def');
  const result=await page.evaluate(()=>{
    const o=window.ownedIme,area=o.textarea;
    const edit=(start:number,end:number,text:string,inputType:string)=>{
      area.setSelectionRange(start,end);
      area.dispatchEvent(new InputEvent('beforeinput',{inputType,data:text||null,bubbles:true,composed:true,cancelable:true}));
      area.setRangeText(text,start,end,'end');
      area.dispatchEvent(new InputEvent('input',{inputType,data:text||null,bubbles:true,composed:true}));
    };
    edit(4,7,'','deleteContentForward');
    edit(0,4,'xyz ','insertReplacementText');
    edit(4,4,'tail','insertText');
    return {writes:o.writes,proposal:o.proposal,readOnly:area.readOnly};
  });
  expect(result).toEqual({writes:['abc def','\x7f\x7f\x7f','\x7f\x7f\x7f\x7fxyz ','tail'],proposal:null,readOnly:false});
});

for(const boundary of ['unicode','cursor'] as const)test(`forward deletion without key229 retains ${boundary} edits for review`,async({page,context})=>{
  await commitNativeComposition(page,context,boundary==='unicode'?'éx':'abc');
  if(boundary==='cursor')await page.keyboard.press('ArrowLeft');
  const result=await page.evaluate(()=>{
    const o=window.ownedIme,area=o.textarea;
    area.setSelectionRange(0,1);
    area.dispatchEvent(new InputEvent('beforeinput',{inputType:'deleteContentForward',bubbles:true,composed:true,cancelable:true}));
    area.setRangeText('',0,1,'end');
    area.dispatchEvent(new InputEvent('input',{inputType:'deleteContentForward',bubbles:true,composed:true}));
    return {writes:o.writes,proposal:o.proposal,readOnly:area.readOnly};
  });
  expect(result.writes).toEqual(boundary==='unicode'?['éx']:['abc','\x1b[D']);
  expect(result.proposal).toEqual({text:boundary==='unicode'?'x':'bc',truncated:false});
  expect(result.readOnly).toBe(true);
});
