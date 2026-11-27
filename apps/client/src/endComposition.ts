import type {RefObject} from 'react';

/** Leaving the field commits an open touch-keyboard composition, including WebViews that omit compositionend. */
export function endComposition(field:HTMLTextAreaElement|null,composing:RefObject<boolean>,fallback:string,finish:(value:string)=>void):boolean {
  if(!composing.current)return false;
  field?.blur();
  if(composing.current){composing.current=false;finish(field?.value ?? fallback);}
  return true;
}
