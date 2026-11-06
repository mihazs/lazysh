export type Geometry={cols:number;rows:number};
export type WindowSize={width:number;height:number};
/** Remote rows kept while a soft keyboard covers the bottom of a Mosh screen. */
export type KeyboardHold=Geometry&{width:number};
export type MoshKeyboardFit={
  /** The pane's measured fit. */
  proposed:Geometry;
  /** The geometry last asked of the server, else the current canonical screen. */
  desired:Geometry;
  hold:KeyboardHold|null;
  /** A touch-first device, where a soft keyboard shrinks the window. */
  touch:boolean;
  window:WindowSize;
  /** The window at the previous fit, undefined before the first one. */
  previous:WindowSize|undefined;
};

/** mosh-server shrinks its screen from the top: it keeps the top rows and
 * drops the bottom ones, where the newest output and the cursor usually are.
 * A soft keyboard shrinks only the window's height, for as long as it is
 * open, so its rows are held remotely and the pane pans to the cursor instead.
 * Any other fit, and a width change, sizes the remote screen as measured.
 */
export function fitMoshKeyboard({proposed,desired,hold,touch,window,previous}:MoshKeyboardFit):{request:Geometry;hold:KeyboardHold|null} {
  if(!touch)return {request:proposed,hold:null};
  if(hold)return proposed.cols===hold.cols&&window.width===hold.width&&proposed.rows<hold.rows
    ?{request:{cols:hold.cols,rows:hold.rows},hold}:{request:proposed,hold:null};
  const keyboard=previous!==undefined&&window.width===previous.width&&window.height<previous.height
    &&proposed.cols===desired.cols&&proposed.rows<desired.rows;
  return keyboard?{request:{cols:desired.cols,rows:desired.rows},hold:{...desired,width:window.width}}:{request:proposed,hold:null};
}

/** The upward pan, in CSS pixels, that keeps the cursor row inside the pane. */
export function moshKeyboardPan({rows,rowHeight,visible,cursorRow}:{rows:number;rowHeight:number;visible:number;cursorRow:number}):number {
  if(![rows,rowHeight,visible,cursorRow].every(Number.isFinite)||rowHeight<=0||visible<=0||cursorRow<0||cursorRow>=rows)return 0;
  const limit=Math.max(0,rows*rowHeight-visible);
  return Math.min(limit,Math.max(0,Math.ceil((cursorRow+1)*rowHeight-visible)));
}
