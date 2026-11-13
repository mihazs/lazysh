/** Pull-to-refresh, the Settings action and a finished companion install ask the mounted Agents readers to read again now. */
const event='lazysh-agents-refresh';
/** `force` also drops a read already in flight, whose answer predates a change such as a new companion. */
export const refreshAgents=(force=false)=>window.dispatchEvent(new CustomEvent(event,{detail:force}));
/** Runs `read` on every refresh request until the returned cleanup runs. */
export function onAgentsRefresh(read:(force:boolean)=>void) {
  const listener=(request:Event)=>read((request as CustomEvent<boolean>).detail===true);
  window.addEventListener(event,listener);
  return()=>window.removeEventListener(event,listener);
}
