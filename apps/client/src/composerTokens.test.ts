// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {atomicComposerEdit,expandComposerDraft,insertComposerToken,liveComposerAttachments,nextComposerAttachmentNumber,onComposerAttachment,removeComposerToken,snapComposerSelection,stageComposerAttachment,type ComposerAttachment} from './composerTokens';

const first:ComposerAttachment={number:1,kind:'image',path:'/tmp/shot one.png',name:'shot one.png'};
const second:ComposerAttachment={number:2,kind:'file',path:"/tmp/it's.txt",name:"it's.txt"};
const both=[first,second];

it('numbers tokens per draft and separates them from neighbouring text',()=>{
  expect(nextComposerAttachmentNumber('describe',[])).toBe(1);
  const one=insertComposerToken('describe',8,first,[]);
  expect(one).toEqual({value:'describe [Image #1] ',caret:20});
  expect(nextComposerAttachmentNumber(one.value,[first])).toBe(2);
  const two=insertComposerToken(one.value,one.caret,second,[first]);
  expect(two.value).toBe('describe [Image #1] [File #2] ');
  // A caret inside an existing token inserts after it, never splitting it.
  expect(insertComposerToken('[Image #1]',4,second,[first]).value).toBe('[Image #1] [File #2] ');
});

it('deletes a token whole when any edit touches part of it',()=>{
  const draft='see [Image #1] and [File #2] now';
  // Backspace right after the token removes its closing bracket in the browser.
  expect(atomicComposerEdit(draft,'see [Image #1 and [File #2] now',both)).toEqual({value:'see  and [File #2] now',caret:4});
  // Forward delete at the token start.
  expect(atomicComposerEdit(draft,'see Image #1] and [File #2] now',both)).toEqual({value:'see  and [File #2] now',caret:4});
  // A selection replacement crossing into the second token.
  expect(atomicComposerEdit(draft,'see [Image #1] andX#2] now',both).value).toBe('see [Image #1] andX now');
  // Typing inside a token lands after it.
  expect(atomicComposerEdit(draft,'see [Imaxge #1] and [File #2] now',both)).toEqual({value:'see [Image #1]x and [File #2] now',caret:15});
  // Edits outside tokens pass through untouched.
  expect(atomicComposerEdit(draft,'see [Image #1] and [File #2] now!',both)).toEqual({value:'see [Image #1] and [File #2] now!'});
  expect(liveComposerAttachments('see  and [File #2] now',both)).toEqual([second]);
});

it('keeps the caret and selections outside tokens',()=>{
  const draft='a [Image #1] b';
  expect(snapComposerSelection(draft,both,5,5)).toEqual({start:12,end:12});
  expect(snapComposerSelection(draft,both,5,5,12)).toEqual({start:2,end:2});
  expect(snapComposerSelection(draft,both,0,5)).toEqual({start:0,end:12});
  expect(snapComposerSelection(draft,both,13,13)).toEqual({start:13,end:13});
});

it('removes a chip with its separator and expands the rest to quoted upload paths in order',()=>{
  expect(removeComposerToken('[Image #1] [File #2] go',first)).toBe('[File #2] go');
  expect(removeComposerToken('go [Image #1] now',first)).toBe('go now');
  expect(expandComposerDraft('[Image #1] [File #2] compare [Image #9]',both)).toBe("'/tmp/shot one.png' '/tmp/it'\\''s.txt' compare [Image #9]");
});

it('never numbers a new token after token text the user typed or a released attachment',()=>{
  // Text copied from an agent CLI keeps its literal reference; the upload takes the next free number.
  const typed='[Image #1] is my label [File #2]';
  expect(nextComposerAttachmentNumber(typed,[])).toBe(3);
  const third={...first,number:nextComposerAttachmentNumber(typed,[])};
  const draft=insertComposerToken(typed,typed.length,third,[]).value;
  expect(draft).toBe('[Image #1] is my label [File #2] [Image #3] ');
  expect(expandComposerDraft(draft,[third])).toBe("[Image #1] is my label [File #2] '/tmp/shot one.png' ");
  expect(removeComposerToken(draft,third)).toBe('[Image #1] is my label [File #2] ');
  // A released attachment keeps its number for the rest of the draft.
  expect(nextComposerAttachmentNumber('',both)).toBe(3);
});

it('refuses to stage an upload path a terminal could not receive literally',()=>{
  const received:unknown[]=[];
  const stop=onComposerAttachment('s',attachment=>received.push(attachment));
  try {
    for(const path of ['/host/unsafe\x9b201~path','relative.png','/a/../b','/'+'a'.repeat(4096)])
      expect(()=>stageComposerAttachment('s',{kind:'image',path,name:'x.png'})).toThrow('valid single-line absolute path');
    expect(received).toEqual([]);
    stageComposerAttachment('s',{kind:'file',path:'/tmp/ok.txt',name:'ok.txt'});
    expect(received).toEqual([{kind:'file',path:'/tmp/ok.txt',name:'ok.txt',preview:undefined}]);
  } finally {stop();}
});
