import {useEffect,useRef,useState,type CSSProperties,type RefObject} from 'react';
import {RefreshCw} from 'lucide-react';
import {t,useUi} from './i18n/core';
import {refreshAgents} from './agentsRefresh';
import './PullToRefresh.css';

/** The indicator grows to this many px at half the finger's travel, and letting go at TRIGGER or more reads. */
const MAX=64,TRIGGER=40;
/** The readers answer through their own state; the indicator only says the request went out. */
const SHOWN_MS=900;

/**
 * Pull-to-refresh for a scroller that is at its top: dragging the list down with a finger reads the Agents lists again.
 * Touch only, so a mouse drag still selects text. Settings > Agents has the same action as a button.
 */
export default function PullToRefresh({scroller,enabled}:{scroller:RefObject<HTMLElement|null>;enabled:boolean}) {
  useUi();
  const [pull,setPull]=useState(0);
  const [reading,setReading]=useState(false);
  const timer=useRef(0);
  useEffect(()=>()=>window.clearTimeout(timer.current),[]);
  useEffect(()=>{
    const node=scroller.current;
    if(!node || !enabled)return;
    let start:{x:number;y:number}|null=null,distance=0;
    const set=(value:number)=>{distance=value;setPull(value);};
    const down=(event:TouchEvent)=>{start=event.touches.length===1 && node.scrollTop<=0?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;};
    const move=(event:TouchEvent)=>{
      if(!start)return;
      const {clientX,clientY}=event.touches[0];
      const dy=clientY-start.y;
      // A sideways drag (the status chips, a page swipe) never pulls, and neither does scrolling back up.
      if(Math.abs(clientX-start.x)>Math.abs(dy)){start=null;set(0);return;}
      set(dy>0 && node.scrollTop<=0?Math.min(MAX,dy/2):0);
    };
    const up=()=>{
      const pulled=distance>=TRIGGER;
      start=null;set(0);
      if(!pulled)return;
      refreshAgents();setReading(true);
      window.clearTimeout(timer.current);timer.current=window.setTimeout(()=>setReading(false),SHOWN_MS);
    };
    const cancel=()=>{start=null;set(0);};
    node.addEventListener('touchstart',down,{passive:true});
    node.addEventListener('touchmove',move,{passive:true});
    node.addEventListener('touchend',up);
    node.addEventListener('touchcancel',cancel);
    return()=>{node.removeEventListener('touchstart',down);node.removeEventListener('touchmove',move);node.removeEventListener('touchend',up);node.removeEventListener('touchcancel',cancel);};
  },[scroller,enabled]);
  const label=reading?t('agentsRefreshing'):pull>=TRIGGER?t('agentsReleaseToRefresh'):t('agentsPullToRefresh');
  return <div className="pull-refresh" aria-hidden="true" data-pulling={pull>0||undefined} data-reading={reading||undefined} style={{'--pull':`${pull}px`} as CSSProperties}>
    <span><RefreshCw size={16}/>{label}</span>
  </div>;
}
