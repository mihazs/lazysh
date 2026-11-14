import type {ILink, Terminal} from '@xterm/xterm';
import {findPaths, findUrls, type PathLink} from '../terminalLinks';
import {terminalCellAt} from './selection';

/**
 * Registers URL and host-path detection on `terminal` and routes OSC 8 hyperlinks to the URL handler. xterm asks
 * its OSC 8 provider first and drops overlapping links of later providers, so an application's explicit hyperlink
 * wins over a URL guessed from the same cells, and a URL over a path guessed inside it.
 */
export function installTerminalLinks(terminal: Terminal, open: (url: string) => void, hostPaths?: {exists: (link: PathLink) => Promise<boolean>; open: (link: PathLink) => void}) {
  const urls = terminal.registerLinkProvider({
    provideLinks: (line, callback) => callback(findUrls(terminal.buffer.active, terminal.cols, line)
      .map<ILink>(({text, range}) => ({text, range, activate: (_event, uri) => open(uri)}))),
  });
  // Only paths the host confirms are links, so prose and false positives stay plain text.
  const paths = hostPaths && terminal.registerLinkProvider({
    provideLinks: (line, callback) => {
      const found = findPaths(terminal.buffer.active, terminal.cols, line).slice(0, 8);
      void Promise.all(found.map(link => hostPaths.exists(link).catch(() => false))).then(ok => callback(found
        .filter((_, index) => ok[index])
        .map<ILink>(link => ({text: link.text, range: link.range, activate: () => hostPaths.open(link)}))));
    },
  });
  terminal.options.linkHandler = {activate: (_event, uri) => open(uri)};
  const taps = hostPaths && openPathsTappedByFinger(terminal, hostPaths);
  return {dispose() { urls.dispose(); paths?.dispose(); taps?.(); terminal.options.linkHandler = null; }};
}

/**
 * A finger has no hover, and xterm activates a link only if its provider answered while the pointer was over it. A tap
 * delivers mouseover, mousemove, mousedown, mouseup and click within two milliseconds and the pointer leaves the terminal
 * right after, but the path provider answers only after the host confirmed the file. So a tap reads the path under it from
 * the buffer, asks the host and opens it itself; a mouse still uses xterm's hover.
 */
function openPathsTappedByFinger(terminal: Terminal, hostPaths: {exists: (link: PathLink) => Promise<boolean>; open: (link: PathLink) => void}) {
  let touched = false;
  // On the document, because the links are installed before the terminal is opened and has an element.
  const inside = (event: Event) => event.target instanceof Node && !!terminal.element?.contains(event.target);
  const pressed = (event: Event) => { touched = inside(event) && (event as PointerEvent).pointerType === 'touch'; };
  const clicked = (event: MouseEvent) => {
    if (!touched || !inside(event)) return;
    touched = false;
    const cell = terminalCellAt(terminal, event.clientX, event.clientY);
    if (!cell) return;
    const [x, y] = [cell.x + 1, cell.y + 1];
    const link = findPaths(terminal.buffer.active, terminal.cols, y).slice(0, 8).find(({range: {start, end}}) =>
      (y > start.y || (y === start.y && x >= start.x)) && (y < end.y || (y === end.y && x <= end.x)));
    if (link) void hostPaths.exists(link).then(found => { if (found) hostPaths.open(link); }, () => {});
  };
  document.addEventListener('pointerdown', pressed, true);
  document.addEventListener('click', clicked, true);
  return () => { document.removeEventListener('pointerdown', pressed, true); document.removeEventListener('click', clicked, true); };
}
