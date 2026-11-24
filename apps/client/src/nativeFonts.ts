/**
 * The fonts imported in Preferences for the native renderer (#2223). They live in this WebView's IndexedDB, which the app's renderer
 * cannot read, so the page hands the app the bytes of each one a family list names, once, under the same family name the list
 * carries (`lazysh-font-<id>-primary` or `-cjk`), and the renderer registers the ones its look names before the machine's fonts.
 */
import {invoke, isTauri} from '@tauri-apps/api/core';
import {captureAccess, type AccessLease} from './access';
import {importedFontOf, isImportedFamily} from './fonts';

/** What the app holds for each imported family this page handed it: whether it does. */
const handed = new Map<string, Promise<boolean>>();

/** The families of a CSS `font-family` list, without their quotes. */
const familiesOf = (list: string) => list.split(',').map(name => name.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

async function hand(name: string, lease: AccessLease) {
  try {
    const font = await importedFontOf(name);
    if (!font || !lease.current()) return false;
    // The file travels as the request's bytes, with what the app needs to name and restrict it in the headers.
    await invoke('native_terminal_font_import', new Uint8Array(font.bytes), {headers: {...lease.headers, 'x-lazysh-font-family': name, 'x-lazysh-font-role': font.role}});
    return true;
  } catch {
    // A refused font (a locked app, a build without the renderer) stays out: its family falls through to the machine's fonts, and the next list asks again.
    return false;
  }
}

/**
 * Makes sure the app has the imported fonts `familyList` names, and lets go of the ones it no longer names. Resolves once the app holds
 * them, so a look that names them can follow; never rejects, because the terminal draws without them.
 */
export async function shareImportedFonts(familyList: string): Promise<void> {
  if (!isTauri()) return;
  const wanted = new Set(familiesOf(familyList).filter(isImportedFamily));
  const lease = captureAccess();
  for (const [name, held] of handed) {
    if (wanted.has(name)) continue;
    handed.delete(name);
    void held.then(was => was && invoke('native_terminal_font_forget', {family: name}, {headers: lease.headers})).catch(() => undefined);
  }
  await Promise.all([...wanted].map(name => {
    if (!handed.has(name)) handed.set(name, hand(name, lease).then(held => { if (!held) handed.delete(name); return held; }));
    return handed.get(name);
  }));
}
