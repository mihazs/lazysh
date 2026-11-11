import {useRef,type ReactNode} from 'react';
import {useEdgeGestures,useSwipeToClose} from '../../src/edgeGestures';
import {loggingHandlers} from '../../src/edgeGestureLog';

/** Records every engine callback in `log`, around whatever surface the test mounts; `close` also arms a right swipe-to-close over the whole surface. */
export default function EdgeGestureHost({log,close=false,children}:{log:string[];close?:boolean;children:ReactNode}) {
  const ref=useRef<HTMLDivElement>(null);
  useEdgeGestures({enabled:true,edges:['left','right','bottom'],target:ref,handlers:loggingHandlers(log)});
  useSwipeToClose({enabled:close,direction:'right',target:ref,onProgress:progress=>log.push(`close:${progress.toFixed(2)}`),onCommit:()=>log.push('closed'),onCancel:()=>log.push('close-cancelled')});
  return <div ref={ref} style={{display:'flex',flexDirection:'column',flex:'1 1 auto',minHeight:0,width:'100%'}}>
    <input aria-label="Synthetic text field" style={{position:'absolute',top:0,left:0,width:120,zIndex:5}} />
    {children}
  </div>;
}
