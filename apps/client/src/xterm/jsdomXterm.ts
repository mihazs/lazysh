/** jsdom has no matchMedia or canvas; xterm's DOM renderer needs only the former. */
export function stubMatchMedia() {
  window.matchMedia = ((query: string) => ({matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}})) as never;
}
