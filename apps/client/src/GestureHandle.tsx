import {createPortal} from 'react-dom';
import {useEdgeGestureMode, type Edge, type EdgeGestureId} from './edgeGestures';
import {handleBox, useGestureInsets, useGestureMode, useViewport} from './gestureInsets';
import './GestureHandle.css';

/**
 * The visible grip of an edge gesture: a tab you drag, or tap, to do what the edge swipe does. It sits inside the system's
 * gesture zones (beside the Back zone, above the Home zone), so the system never takes its touches, and it is a button a
 * keyboard user reaches. It is drawn on the page itself, so its viewport coordinates hold whatever it is rendered inside,
 * and the engine watches the page for its touches. Nothing is drawn while the gesture
 * is switched off (its caller shows a button instead). Under the edge-swipe mode only the bottom grip is drawn, as a hint
 * that takes no touch, so it never covers a key or a terminal line.
 */
export default function GestureHandle({edge, gesture, label, onActivate, hidden}: {edge: Edge; gesture: EdgeGestureId; label: string; onActivate: () => void; hidden?: boolean}) {
  const insets = useGestureInsets(), view = useViewport();
  const mode = useGestureMode(), enabled = useEdgeGestureMode(gesture) === 'gesture';
  const box = enabled && (mode === 'handles' || (mode === 'edges' && edge === 'bottom')) ? handleBox(edge, insets, view) : null;
  if (!box) return null;
  const hint = mode === 'edges';
  // The terminal keeps its focus (and the soft keyboard) while the handle is touched.
  return createPortal(<button type="button" className="gesture-handle" data-gesture-handle={edge} data-edge-gestures-handle={hint ? undefined : edge} data-hint={hint || undefined} data-hidden={hidden || undefined}
    aria-label={label} aria-hidden={hint || undefined} tabIndex={hint ? -1 : undefined} style={{left: box.left, top: box.top, width: box.width, height: box.height}}
    onPointerDown={event => event.preventDefault()} onClick={onActivate}><span aria-hidden="true" /></button>, document.body);
}
