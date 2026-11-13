// @vitest-environment jsdom
import {createRef} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import PullToRefresh from './PullToRefresh';
import {onAgentsRefresh} from './agentsRefresh';

afterEach(cleanup);
/** A finger that goes down at (100,100) on a scroller and moves to (x,y), then lifts. */
function drag(to:{x:number;y:number},{scrollTop=0,enabled=true}:{scrollTop?:number;enabled?:boolean}={}) {
  const scroller=createRef<HTMLDivElement>();
  const asked=vi.fn();const off=onAgentsRefresh(asked);
  const view=render(<div ref={scroller}><PullToRefresh scroller={scroller} enabled={enabled}/></div>);
  // The effect attaches after the first commit, when the ref is set.
  view.rerender(<div ref={scroller}><PullToRefresh scroller={scroller} enabled={enabled}/></div>);
  const node=scroller.current!;node.scrollTop=scrollTop;
  const touch=(x:number,y:number)=>({touches:[{clientX:x,clientY:y}]});
  act(()=>{fireEvent.touchStart(node,touch(100,100));fireEvent.touchMove(node,touch(100+(to.x-100)/2,100+(to.y-100)/2));fireEvent.touchMove(node,touch(to.x,to.y));});
  const label=node.querySelector('.pull-refresh')!;
  const during={pulling:label.hasAttribute('data-pulling'),text:label.textContent};
  act(()=>{fireEvent.touchEnd(node);});
  off();
  return {asked,during,after:{reading:label.hasAttribute('data-reading')}};
}

it('reads the Agents lists once when a finger pulls the list down far enough and lets go',()=>{
  const result=drag({x:100,y:260});
  expect(result.during).toEqual({pulling:true,text:'Release to refresh'});
  expect(result.asked).toHaveBeenCalledOnce();expect(result.asked).toHaveBeenCalledWith(false);
  expect(result.after.reading).toBe(true);
});
it('does nothing for a short pull, a sideways drag, a drag up, a list scrolled down, or while disabled',()=>{
  expect(drag({x:100,y:150}).asked).not.toHaveBeenCalled();
  expect(drag({x:260,y:150}).asked).not.toHaveBeenCalled();
  expect(drag({x:100,y:20}).asked).not.toHaveBeenCalled();
  expect(drag({x:100,y:260},{scrollTop:40}).asked).not.toHaveBeenCalled();
  expect(drag({x:100,y:260},{enabled:false}).asked).not.toHaveBeenCalled();
});
it('shows a hint while pulling that says pull first and release after the distance is reached',()=>{
  expect(drag({x:100,y:150}).during.text).toBe('Pull to refresh');
});
