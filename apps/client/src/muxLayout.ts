/** The Jump To / Workspaces layout shared by the tmux, Herdr and multiplexer panels. */
const key='lazysh.multiplexer.layout';
export type MuxLayout='list'|'accordion'|'grid';
export function readMuxLayout():MuxLayout {
  try {const value=localStorage.getItem(key);return value==='accordion'||value==='grid'?value:'list';} catch {return 'list';}
}
export function writeMuxLayout(layout:MuxLayout) {
  try {localStorage.setItem(key,layout);} catch {/* The layout stays usable without persistence. */}
}
