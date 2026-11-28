import {adbFor, type Adb} from './device';

/** The editor setup the soft keyboard was given for the focused input: what Android's `EditorInfo` carries. */
export interface EditorSetup {inputType: number; imeOptions: number; privateImeOptions: string | null}

// Android's own constants (InputType, EditorInfo).
const TEXT_VISIBLE_PASSWORD_NO_SUGGESTIONS = 0x80091;
const IME_FLAG_NO_PERSONALIZED_LEARNING = 0x1000000;

/** Reads the setup the keyboard holds for the input that has focus now, from the system's input method service. */
export async function focusedEditor(adb: Adb = adbFor(process.env.ANDROID_SERIAL ?? '')): Promise<EditorSetup> {
  const dump = await adb('shell', 'dumpsys', 'input_method');
  const found = /mInputEditorInfo:\s+inputType=0x([0-9a-f]+) imeOptions=0x([0-9a-f]+) privateImeOptions=(\S+)/i.exec(dump);
  if (!found) throw new Error('No focused editor reported by the input method service');
  return {inputType: parseInt(found[1], 16), imeOptions: parseInt(found[2], 16), privateImeOptions: found[3] === 'null' ? null : found[3]};
}

/** Whether the keyboard was asked to behave as a plain key source: no suggestions, a visible password field, no learning. */
export const isPrivate = (editor: EditorSetup) =>
  editor.inputType === TEXT_VISIBLE_PASSWORD_NO_SUGGESTIONS && (editor.imeOptions & IME_FLAG_NO_PERSONALIZED_LEARNING) !== 0;
