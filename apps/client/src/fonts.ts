import {t} from './i18n/core';
import {LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import { useEffect, useSyncExternalStore } from "react";
import type { Preferences } from "./preferences";

export const FONT_LIMIT = 24 * 1024 * 1024;
export const FONT_TOTAL_LIMIT = 48 * 1024 * 1024;
export const FONT_COUNT_LIMIT = 4;
const databaseName = "lazysh-fonts-v1";
const selectionKey = "lazysh.device-fonts.v1";
type FontRecord = { id: string; name: string; size: number; bytes: ArrayBuffer };
export type FontInfo = Omit<FontRecord, "bytes">;
type Selection = { primary?: string; cjk?: string };
export type FontWarning = {kind:'missing';role:keyof Selection} | {kind:'load';role:keyof Selection;name:string} | {kind:'error';cause:UiErrorCause};
/** Preserve opaque browser/storage diagnostics; only our own finite errors are translated. */
export function fontErrorCause(error:unknown):UiErrorCause {return error instanceof LocalUiError?error:String(error);}
export function fontWarningKey(warning:FontWarning) {return warning.kind==='error'?'error':`${warning.kind}:${warning.role}`;}
export function fontWarningText(warning:FontWarning):string {
  if(warning.kind==='error')return uiErrorText(warning.cause);
  if(warning.kind==='load')return t('fontCannotLoadValue1UsingTheFallbackFontStack',{value1:warning.name});
  return t('fontTheSelectedValue1FontIsMissingOnThisDevice',{value1:t(warning.role==='cjk'?'fontRoleCjk':'fontRoleTerminal')});
}
type FontState = { fonts: FontInfo[]; selection: Selection; primaryFamily?: string; cjkFamily?: string; warnings: FontWarning[]; ready: boolean };
let state: FontState = {fonts: [], selection: {}, warnings: [], ready: false};
let initialized = false;
let generation = 0;
const listeners = new Set<() => void>();
const faces = new Map<string, FontFace>();
function publish(next: FontState) {state = next; for (const listener of listeners) listener();}
function family(id: string, role = "primary") {return `lazysh-font-${id}-${role}`;}
function validId(id: unknown): id is string {return typeof id === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);}
export function validateFont(bytes: ArrayBuffer) {
  if (bytes.byteLength < 12 || bytes.byteLength > FONT_LIMIT) throw new LocalUiError('validationChooseAFontFileBetween12BytesAnd24');
  const signature = new DataView(bytes).getUint32(0);
  if (![0x00010000, 0x4f54544f, 0x774f4646, 0x774f4632, 0x74746366].includes(signature)) throw new LocalUiError('validationChooseATrueTypeOpenTypeWOFFWOFF2OrFontCollection');
}
export function assertFontBudget(sizes: number[]) {
  if (sizes.length > FONT_COUNT_LIMIT || sizes.some(size => !Number.isInteger(size) || size < 12 || size > FONT_LIMIT) || sizes.reduce((total, size) => total + size, 0) > FONT_TOTAL_LIMIT) throw new LocalUiError('validationKeepAtMost4ImportedFontsAnd48MiB');
}
function validateRecord(value: unknown): FontRecord {
  if (!value || typeof value !== "object") throw new LocalUiError('validationASavedFontIsInvalid');
  const font = value as FontRecord;
  if (!validId(font.id) || typeof font.name !== "string" || !font.name || font.name.length > 128 || !(font.bytes instanceof ArrayBuffer) || font.size !== font.bytes.byteLength) throw new LocalUiError('validationASavedFontIsInvalid');
  validateFont(font.bytes);
  return font;
}
function open(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new LocalUiError('validationThisDeviceDoesNotProvideLocalFontStorage'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => {if (!request.result.objectStoreNames.contains("fonts")) request.result.createObjectStore("fonts", {keyPath: "id"});};
    request.onerror = () => reject(new LocalUiError('validationLocalFontStorageIsUnavailable'));
    request.onblocked = () => {blocked = true; reject(new LocalUiError('validationCloseOtherLazyshWindowsBeforeChangingFontStorage'));};
    request.onsuccess = () => {if (blocked) request.result.close(); else resolve(request.result);};
  });
}
async function records(): Promise<FontRecord[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("fonts", "readonly");
      const request = transaction.objectStore("fonts").getAll();
      request.onerror = () => reject(new LocalUiError('validationCannotReadSavedFonts'));
      request.onsuccess = () => {
        try {
          const fonts = request.result.map(validateRecord);
          assertFontBudget(fonts.map(font => font.size));
          resolve(fonts);
        } catch (error) {reject(error);}
      };
    });
  } finally {db.close();}
}
function readSelection(): Selection {
  const value: unknown = JSON.parse(localStorage.getItem(selectionKey) ?? "{}");
  if (!value || typeof value !== "object") return {};
  const selection = value as Selection;
  return {...(validId(selection.primary) ? {primary: selection.primary} : {}), ...(validId(selection.cjk) ? {cjk: selection.cjk} : {})};
}
async function refresh() {
  const current = ++generation;
  let selection: Selection = {};
  try {
    selection = readSelection();
    const fonts = await records();
    const warnings: FontWarning[] = [];
    const loaded: {primaryFamily?: string; cjkFamily?: string} = {};
    for (const role of ["primary", "cjk"] as const) {
      const id = selection[role];
      if (!id) continue;
      const record = fonts.find(font => font.id === id);
      if (!record) {warnings.push({kind:'missing',role}); continue;}
      try {
        const faceKey = `${role}:${id}`;
        let face = faces.get(faceKey);
        if (!face) face = await new FontFace(family(id, role), record.bytes, role === "cjk" ? {unicodeRange: "U+1100-11FF,U+2E80-9FFF,U+A960-A97F,U+AC00-D7FF,U+F900-FAFF,U+FF00-FFEF,U+20000-3FFFF"} : {}).load();
        if (current !== generation) return;
        document.fonts.add(face); faces.set(faceKey, face);
        loaded[role === "primary" ? "primaryFamily" : "cjkFamily"] = `"${family(id, role)}"`;
      } catch {warnings.push({kind:'load',role,name:record.name});}
    }
    if (current !== generation) return;
    for (const [faceKey, face] of faces) {
      if (faceKey !== `primary:${selection.primary}` && faceKey !== `cjk:${selection.cjk}`) {document.fonts.delete(face); faces.delete(faceKey);}
    }
    publish({fonts: fonts.map(({id, name, size}) => ({id, name, size})), selection, ...loaded, warnings, ready: true});
  } catch (error) {
    if (current === generation) publish({fonts: [], selection, warnings: [{kind:'error',cause:fontErrorCause(error)}], ready: true});
  }
}
export function initializeFonts() {if (!initialized) {initialized = true; void refresh();}}
export function getDeviceFonts() {return state;}
export function useDeviceFonts() {
  useEffect(initializeFonts, []);
  return useSyncExternalStore(listener => {listeners.add(listener); return () => {listeners.delete(listener);};}, getDeviceFonts, getDeviceFonts);
}
export function fontFamilyFor(preferences: Preferences, fonts = state) {
  return [fonts.primaryFamily, fonts.cjkFamily, preferences.fontFamily, preferences.cjkFallback].filter(Boolean).join(", ");
}
export async function importFont(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, permitted: () => boolean = () => true): Promise<string> {
  const check=()=>{if(!permitted())throw new LocalUiError('fontDownloadCancelled');};
  check();
  if (file.size > FONT_LIMIT || file.size < 12) throw new LocalUiError('validationChooseAFontFileNoLargerThan24MiB');
  if (!globalThis.FontFace || !document.fonts) throw new LocalUiError('validationThisDeviceCannotLoadImportedFonts');
  const bytes = await file.arrayBuffer();
  check(); validateFont(bytes);
  const id = crypto.randomUUID();
  const name = file.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128) || t("fontImported");
  try {await new FontFace(family(id), bytes).load();} catch {throw new LocalUiError('validationTheBrowserRejectedThisFontChooseAValidSupported');}
  check();
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("fonts", "readwrite");
      const store = transaction.objectStore("fonts");
      let failure:UiErrorCause = new LocalUiError('fontSaveFailed');
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          check();
          const existing = request.result.map(validateRecord);
          assertFontBudget([...existing.map(font => font.size), bytes.byteLength]);
          store.add({id, name, size: bytes.byteLength, bytes} satisfies FontRecord);
        } catch (error) {failure = fontErrorCause(error); transaction.abort();}
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(failure instanceof LocalUiError?failure:new Error(failure));
    });
  } finally {db.close();}
  await refresh();
  return id;
}
export async function selectFont(role: keyof Selection, id: string | undefined) {
  const selection = readSelection();
  if (id && !state.fonts.some(font => font.id === id)) throw new LocalUiError('validationThatFontIsUnavailableOnThisDevice');
  localStorage.setItem(selectionKey, JSON.stringify({...selection, [role]: id}));
  await refresh();
}
export async function deleteFont(id: string) {
  if (!validId(id)) throw new LocalUiError('validationInvalidLocalFontIdentity');
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("fonts", "readwrite");
      transaction.objectStore("fonts").delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new LocalUiError('validationTheFontCouldNotBeDeleted'));
    });
  } finally {db.close();}
  const selection = readSelection();
  localStorage.setItem(selectionKey, JSON.stringify({primary: selection.primary === id ? undefined : selection.primary, cjk: selection.cjk === id ? undefined : selection.cjk}));
  await refresh();
}
export async function resetFontSelection() {localStorage.removeItem(selectionKey); await refresh();}
export async function deleteAllFonts() {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("fonts", "readwrite");
      transaction.objectStore("fonts").clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new LocalUiError('validationImportedFontsCouldNotBeDeleted'));
    });
  } finally {db.close();}
  localStorage.removeItem(selectionKey);
  for (const face of faces.values()) document.fonts.delete(face);
  faces.clear();
  await refresh();
}
