import {describe,expect,it} from 'vitest';
import {edgeOverflow,edgeScrollRate,edgeScrollStep,inclusiveEnd,nextTouchSelection,rangeBetween} from './terminalTouchSelection';

describe('terminal selection geometry',()=>{
  it('converts xterm exclusive ends, including a row boundary',()=>{
    expect(inclusiveEnd({x:5,y:3},80)).toEqual({x:4,y:3});
    expect(inclusiveEnd({x:0,y:3},80)).toEqual({x:79,y:2});
  });
  it('orders a dragged handle past its fixed end in either direction',()=>{
    expect(rangeBetween({x:4,y:10},{x:2,y:30})).toEqual({start:{x:4,y:10},end:{x:2,y:30}});
    expect(rangeBetween({x:4,y:10},{x:9,y:2})).toEqual({start:{x:9,y:2},end:{x:4,y:10}});
  });
  it('restarts inside the current range and extends from the first word outside it',()=>{
    const word={start:{x:2,y:5},end:{x:6,y:5}};
    const first=nextTouchSelection(null,word);
    const extended=nextTouchSelection(first,{start:{x:0,y:9},end:{x:3,y:9}});
    expect(extended.range).toEqual({start:{x:2,y:5},end:{x:3,y:9}});
    expect(nextTouchSelection(extended,{start:{x:1,y:7},end:{x:4,y:7}}).range).toEqual({start:{x:1,y:7},end:{x:4,y:7}});
  });
});

describe('edge auto-scroll',()=>{
  it('is still inside the screen and grows with distance past either edge',()=>{
    expect(edgeOverflow(150,100,400)).toBe(0);
    expect(edgeOverflow(90,100,400)).toBe(-10);
    expect(edgeOverflow(460,100,400)).toBe(60);
    expect(edgeScrollRate(0,20)).toBe(0);
    expect(edgeScrollRate(20,20)).toBe(20);
    expect(edgeScrollRate(-20,20)).toBe(-20);
    expect(edgeScrollRate(10_000,20)).toBe(60);
  });
  it('carries fractional rows between frames and caps a stalled frame',()=>{
    let carry=0,rows=0;
    for(let frame=0;frame<60;frame++){const step=edgeScrollStep(5,1000/60,carry);carry=step.carry;rows+=step.rows;}
    expect(rows+carry).toBeCloseTo(5,5);expect(rows).toBeGreaterThanOrEqual(4);
    expect(edgeScrollStep(-60,5000,0)).toEqual({rows:-6,carry:0});
    expect(edgeScrollStep(0,16,0.7)).toEqual({rows:0,carry:0});
  });
});
