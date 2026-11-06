import {describe,expect,it} from "vitest";
import {fitMoshKeyboard,moshKeyboardPan,type KeyboardHold,type MoshKeyboardFit} from "./moshKeyboard";

const phone={width:390,height:844},keyboard={width:390,height:524};
const fit=(change:Partial<MoshKeyboardFit>)=>fitMoshKeyboard({proposed:{cols:47,rows:9},desired:{cols:47,rows:24},hold:null,touch:true,window:keyboard,previous:phone,...change});

describe("fitMoshKeyboard",()=>{
  it("holds the remote rows while a soft keyboard shrinks the window",()=>{
    expect(fit({})).toEqual({request:{cols:47,rows:24},hold:{cols:47,rows:24,width:390}});
  });
  it("keeps the hold through further keyboard changes and releases it once the rows fit again",()=>{
    const hold:KeyboardHold={cols:47,rows:24,width:390};
    expect(fit({hold,proposed:{cols:47,rows:7},previous:keyboard})).toEqual({request:{cols:47,rows:24},hold});
    expect(fit({hold,proposed:{cols:47,rows:24},window:phone,previous:keyboard})).toEqual({request:{cols:47,rows:24},hold:null});
  });
  it("sizes the remote screen as measured for a rotation, even with the keyboard open",()=>{
    const hold:KeyboardHold={cols:47,rows:24,width:390};
    expect(fit({hold,proposed:{cols:96,rows:5},window:{width:844,height:200}})).toEqual({request:{cols:96,rows:5},hold:null});
    expect(fit({hold,proposed:{cols:47,rows:9},window:{width:391,height:524}})).toEqual({request:{cols:47,rows:9},hold:null});
  });
  it("resizes for pane-only changes, desktops and the first fit",()=>{
    // A toolbar or search bar takes rows without shrinking the window.
    expect(fit({window:phone}).request).toEqual({cols:47,rows:9});
    expect(fit({touch:false})).toEqual({request:{cols:47,rows:9},hold:null});
    expect(fit({previous:undefined})).toEqual({request:{cols:47,rows:9},hold:null});
    // Growing never discards rows.
    expect(fit({proposed:{cols:47,rows:30},window:phone,previous:keyboard})).toEqual({request:{cols:47,rows:30},hold:null});
  });
});

describe("moshKeyboardPan",()=>{
  const pane={rows:24,rowHeight:20,visible:180};
  it("pans just far enough to show the cursor row",()=>{
    expect(moshKeyboardPan({...pane,cursorRow:23})).toBe(300);
    expect(moshKeyboardPan({...pane,cursorRow:12})).toBe(80);
    expect(moshKeyboardPan({...pane,cursorRow:3})).toBe(0);
  });
  it("never pans for a cursor outside the viewport or an unmeasured pane",()=>{
    for(const cursorRow of [-1,24,Number.NaN])expect(moshKeyboardPan({...pane,cursorRow})).toBe(0);
    expect(moshKeyboardPan({...pane,cursorRow:23,rowHeight:Number.NaN})).toBe(0);
    expect(moshKeyboardPan({...pane,cursorRow:23,visible:0})).toBe(0);
    expect(moshKeyboardPan({...pane,cursorRow:23,visible:600})).toBe(0);
  });
});
