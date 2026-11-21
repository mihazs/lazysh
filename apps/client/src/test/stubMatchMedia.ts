/** jsdom has no `matchMedia`, and xterm's DOM renderer needs it. */
export function stubMatchMedia() {
  window.matchMedia = ((query: string) => ({matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}})) as never;
}
