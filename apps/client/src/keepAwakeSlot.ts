import {useSyncExternalStore} from 'react';

/**
 * Where Settings > Agents shows the board's keep-awake control. The control itself stays mounted with the
 * Agents board, which is what owns the display while the board is visible, and renders into this slot when Settings has one.
 */
let slot:HTMLElement|null=null;
const listeners=new Set<()=>void>();
export function setKeepAwakeSlot(node:HTMLElement|null) {slot=node;for(const listener of listeners)listener();}
export const useKeepAwakeSlot=()=>useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},()=>slot);
