/**
 * DOM events recorded from an Android 13 WebView (Chromium, x86_64 Waydroid guest) whose textarea was the terminal
 * editor, while a scripted InputMethodService made the InputConnection calls named in each `calls`. Only the calls and
 * the events they produced are kept: no keyboard code, text or resource. `gap` marks the pause between two transactions.
 * Each event is [type, inputType, data, isComposing, value, selectionStart, selectionEnd]; the value is the textarea
 * text at that event (after the edit for `input`), which is all a replay needs to set before dispatching it.
 */
export type RecordedEvent = readonly [type:string,inputType:string,data:string|null,isComposing:boolean,value:string|null,start:number|null,end:number|null,gap?:1];
export interface RecordedTrace {calls:string;line:string;events:readonly RecordedEvent[]}

/** commitText(text, 1) outside a composition, as recorded: the key 229 bracket around one insertText of `text` after `before`. */
const commit=(text:string,before:string):RecordedEvent[]=>[
  ['keydown','',null,false,before,before.length,before.length,1],
  ['beforeinput','insertText',text,false,before,before.length,before.length],
  ['input','insertText',text,false,before+text,before.length+text.length,before.length+text.length],
  ['keyup','',null,false,before+text,before.length+text.length,before.length+text.length],
];

export const recordedTraces: Record<string, RecordedTrace> = {
  composedWordErased: {
    calls: "c:h|c:i|c:%20|s:ls+d:2,0+c:ls|c:%2E|c:%20|c:x",
    line: "hi ls. x",
    events: [
      ...commit("h", ""),
      ...commit("i", "h"),
      ...commit(" ", "hi"),
      ["keydown", "", null, false, "hi ", 3, 3, 1],
      ["compositionstart", "", "", false, null, null, null],
      ["compositionupdate", "", "ls", false, null, null, null],
      ["beforeinput", "insertCompositionText", "ls", true, "hi ", 3, 3],
      ["input", "insertCompositionText", "ls", true, "hi ls", 5, 5],
      ["keyup", "", null, true, "hi ls", 5, 5],
      ["keydown", "", null, true, "hi ls", 5, 5],
      ["beforeinput", "deleteContentBackward", null, false, "hi ls", 3, 5],
      ["input", "deleteContentBackward", null, false, "hi ", 3, 3],
      ["keyup", "", null, false, "hi ", 3, 3],
      ...commit("ls", "hi "),
      ...commit(".", "hi ls"),
      ...commit(" ", "hi ls."),
      ...commit("x", "hi ls. "),
    ],
  },
  regionErasedThenCommitted: {
    calls: "c:h|c:e|c:l|c:l|c:o|r:0,5+d:5,0+c:hallo|c:%2E|c:z",
    line: "hallo.z",
    events: [
      ...commit("h", ""),
      ...commit("e", "h"),
      ...commit("l", "he"),
      ...commit("l", "hel"),
      ...commit("o", "hell"),
      ["compositionstart", "", "", false, null, null, null, 1],
      ["compositionupdate", "", "hello", false, null, null, null],
      ["keydown", "", null, true, "hello", 5, 5],
      ["beforeinput", "deleteContentBackward", null, false, "hello", 0, 5],
      ["input", "deleteContentBackward", null, false, "", 0, 0],
      ["keyup", "", null, false, "", 0, 0],
      ...commit("hallo", ""),
      ...commit(".", "hallo"),
      ...commit("z", "hallo."),
    ],
  },
  autospaceDot: {
    calls: "c:h|c:i|r:0,2+s:hi+f|c:%20|d:1,0+c:%2E%20|c:o|c:k",
    line: "hi. ok",
    events: [
      ...commit("h", ""),
      ...commit("i", "h"),
      ["compositionstart", "", "", false, null, null, null, 1],
      ["compositionupdate", "", "hi", false, null, null, null],
      ["keydown", "", null, true, "hi", 2, 2],
      ["compositionupdate", "", "hi", false, null, null, null],
      ["beforeinput", "insertCompositionText", "hi", true, "hi", 0, 2],
      ["input", "insertCompositionText", "hi", true, "hi", 2, 2],
      ["keyup", "", null, true, "hi", 2, 2],
      ["compositionend", "", "hi", false, null, null, null],
      ...commit(" ", "hi"),
      ["keydown", "", null, false, "hi ", 3, 3, 1],
      ["beforeinput", "deleteContentBackward", null, false, "hi ", 2, 3],
      ["input", "deleteContentBackward", null, false, "hi", 2, 2],
      ["keyup", "", null, false, "hi", 2, 2],
      ...commit(". ", "hi"),
      ...commit("o", "hi. "),
      ...commit("k", "hi. o"),
    ],
  },
};
