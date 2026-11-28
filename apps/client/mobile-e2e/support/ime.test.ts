import {expect, test} from 'bun:test';
import {focusedEditor, isPrivate} from './ime';

// Excerpts of `dumpsys input_method` from the Waydroid guest (Android 13, AOSP Latin IME) for the two editor setups.
const dump = (inputType: string, imeOptions: string) => `
  mServedInputConnection=RemoteInputConnectionImpl{connection=WV.cj1@58cd252 finished=false}
  mInputEditorInfo:
    inputType=${inputType} imeOptions=${imeOptions} privateImeOptions=null
    contentMimeTypes=null
  mInputAttributes = InputAttributes: inputType=0x000a00a1 noAutoCorrect insertSpaces targetApp=app.lazysh.client
`;
const adbReturning = (text: string) => async () => text;

test('the editor setup is read from the focused input, and Chromium\'s ordinary one is not private', async () => {
  const editor = await focusedEditor(adbReturning(dump('0xa00a1', '0x12000001')));
  expect(editor).toEqual({inputType: 0xa00a1, imeOptions: 0x12000001, privateImeOptions: null});
  expect(isPrivate(editor)).toBe(false);
});

test('the private keyboard setup is recognised by its input type and the no-learning flag together', async () => {
  expect(isPrivate(await focusedEditor(adbReturning(dump('0x80091', '0x13000001'))))).toBe(true);
  expect(isPrivate(await focusedEditor(adbReturning(dump('0x80091', '0x12000001'))))).toBe(false);
  expect(isPrivate(await focusedEditor(adbReturning(dump('0xa00a1', '0x13000001'))))).toBe(false);
});

test('no focused input is an error rather than an ordinary setup', async () => {
  await expect(focusedEditor(adbReturning('mCurId=com.android.inputmethod.latin/.LatinIME'))).rejects.toThrow('No focused editor');
});
