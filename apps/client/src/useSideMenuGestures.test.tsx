// @vitest-environment jsdom
import {createRef} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,renderHook} from '@testing-library/react';

type Edge={onProgress:(edge:string,progress:number)=>void;onCommit:()=>void;onCancel:()=>void};
type Close={onProgress:(progress:number)=>void;onCommit:()=>void;onCancel:()=>void};
const captured={edge:undefined as Edge|undefined,close:undefined as Close|undefined,edgeEnabled:false,closeEnabled:false};
vi.mock('./edgeGestures',()=>({
  useEdgeGestures:(options:{enabled:boolean;handlers:Edge})=>{captured.edge=options.handlers;captured.edgeEnabled=options.enabled;},
  useSwipeToClose:(options:Close&{enabled:boolean})=>{captured.close=options;captured.closeEnabled=options.enabled;},
}));
const {useSideMenuGestures}=await import('./useSideMenuGestures');

const progress=(node:HTMLElement)=>node.style.getPropertyValue('--side-menu-progress');
function mount(open:boolean,enabled=true) {
  const menu=createRef<HTMLElement>();
  const node=document.createElement('aside');
  (menu as {current:HTMLElement}).current=node;
  const onOpen=vi.fn(),onClose=vi.fn();
  const view=renderHook(({open}:{open:boolean})=>useSideMenuGestures({shell:createRef(),menu,enabled,open,onOpen,onClose}),{initialProps:{open}});
  return {node,onOpen,onClose,setOpen:(next:boolean)=>view.rerender({open:next})};
}
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('side menu page gestures',()=>{
  it('opens only from the edge while closed and closes only by the swipe on it while open',()=>{
    mount(false);
    expect([captured.edgeEnabled,captured.closeEnabled]).toEqual([true,false]);
    mount(true);
    expect([captured.edgeEnabled,captured.closeEnabled]).toEqual([false,true]);
    mount(false,false);
    expect([captured.edgeEnabled,captured.closeEnabled]).toEqual([false,false]);
  });

  it('follows the finger, then holds the open position until the page closes',()=>{
    const {node,onOpen,setOpen}=mount(false);
    captured.edge!.onProgress('left',0.4);
    expect(node.hasAttribute('data-dragging')).toBe(true);
    expect(progress(node)).toBe('0.4');
    captured.edge!.onCommit();
    expect(onOpen).toHaveBeenCalledOnce();
    setOpen(true);
    vi.advanceTimersByTime(500);
    expect(progress(node)).toBe('1');
    // Closed by a button, Back or a swipe: the stylesheet decides again.
    setOpen(false);
    expect(progress(node)).toBe('');
    expect(node.hasAttribute('data-dragging')).toBe(false);
  });

  it('hands a cancelled open drag back to the stylesheet after it slides home',()=>{
    const {node,onOpen}=mount(false);
    captured.edge!.onProgress('left',0.2);
    captured.edge!.onCancel();
    expect(progress(node)).toBe('0');
    vi.advanceTimersByTime(300);
    expect(progress(node)).toBe('');
    expect(node.hasAttribute('data-dragging')).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('closes by the opposite swipe and keeps the page open when that swipe is cancelled',()=>{
    const {node,onClose}=mount(true);
    captured.close!.onProgress(0.25);
    expect(progress(node)).toBe('0.75');
    captured.close!.onCancel();
    expect(progress(node)).toBe('1');
    expect(onClose).not.toHaveBeenCalled();
    captured.close!.onProgress(0.9);
    captured.close!.onCommit();
    expect(onClose).toHaveBeenCalledOnce();
    expect(progress(node)).toBe('0');
    vi.advanceTimersByTime(300);
    expect(progress(node)).toBe('');
  });
});
