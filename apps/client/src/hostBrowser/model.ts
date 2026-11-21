/** What the host browser's controls show and ask for, whatever carries the page to the device. */

/** Text that a page chose: a title, an address, a dialog message. Shown as text, never as markup. */
export type Untrusted = string;
export type Tab = { id: string; title: Untrusted; url: Untrusted };
export type View = { tabs: Tab[]; activeId: string | null; canGoBack: boolean; canGoForward: boolean; loading: boolean };
export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload';
export type PageDialog = { kind: DialogKind; message: Untrusted; defaultPrompt: Untrusted };
/** A thing the page tried to do that the host browser never allows. Each is reported once until dismissed. */
export type Blocked = 'download' | 'fileChooser';

export const emptyView: View = { tabs: [], activeId: null, canGoBack: false, canGoForward: false, loading: false };

/** What the controls do. Every method refuses with an `Error` instead of acting on a bad input. */
export interface Navigation {
  navigate(address: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  activate(id: string): Promise<void>;
  newTab(): Promise<void>;
  closeTab(id: string): Promise<void>;
  answer(accept: boolean, text?: string): Promise<void>;
}

// Characters that reorder or hide text (bidirectional overrides and isolates, zero width, the byte order mark), and control characters.
const invisible = /[\u{61c}\u{180e}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{feff}]/gu;
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Page text made safe to show as text: no control or text-reordering characters, bounded in length. A title or
 * address that lies about where it is, or a dialog that pushes its own text out of view, gets neither.
 */
export function untrusted(value: unknown, max: number, multiline = false): Untrusted {
  if (typeof value !== 'string') return '';
  const shown = value.replace(invisible, '');
  const text = multiline ? shown.replace(/\r\n?/g, '\n').replace(/[^\S\n]/g, ' ') : shown.replace(/\s/g, ' ');
  const clean = text.replace(controls, '');
  const characters = [...clean];
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : clean;
}

export type TargetInfo = { targetId: string; type: string; title?: string; url?: string };

/** The pages among a browser's targets, in the order the browser reports them. Workers, extensions and the browser's own UI are not tabs. */
export function pageTabs(infos: readonly TargetInfo[]): Tab[] {
  return infos.filter(info => info.type === 'page').map(info => ({
    id: info.targetId, title: untrusted(info.title, 200), url: untrusted(info.url, 2048),
  }));
}

export type History = { currentIndex: number; entries: { id: number }[] };

/** Where back and forward lead, from a navigation history. */
export function historyReach(history: History | null) {
  const index = history?.currentIndex ?? 0, last = (history?.entries.length ?? 1) - 1;
  return { back: index > 0 ? history!.entries[index - 1].id : undefined, forward: index < last ? history!.entries[index + 1].id : undefined };
}
