/**
 * Makes xterm.js 5.5.0 behave as on `platform` for the module graph that loads it next. It decides
 * macOS and Windows rules once, at load, from `navigator.platform`, but treats a Node process as the
 * platform "node": hide `process.title` while it loads. Call the returned function once it has loaded.
 */
export function emulatePlatform(platform: string) {
  const title = Object.getOwnPropertyDescriptor(process, 'title');
  Object.defineProperty(navigator, 'platform', {value: platform, configurable: true});
  delete (process as {title?: string}).title;
  return () => { if (title) Object.defineProperty(process, 'title', title); };
}
