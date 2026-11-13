import type {ILink, Terminal} from '@xterm/xterm';
import {findPaths, findUrls, type PathLink} from '../terminalLinks';

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
  return {dispose() { urls.dispose(); paths?.dispose(); terminal.options.linkHandler = null; }};
}
