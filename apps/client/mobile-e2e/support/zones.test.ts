import {expect, test} from 'bun:test';
import {parseFocusedPackage, parseSystemZones} from './zones';

// Lines as `dumpsys window displays` prints them on Android 13 (the Waydroid guest); the first copy of each source is the one read.
const source = (type: string, frame: string) => `        InsetsSource type=ITYPE_${type} frame=${frame} visible=true insetsRoundedCornerFrame=false`;
const dump = (left: string, right: string, bottom: string) =>
  ['  Display: mDisplayId=0', source('LEFT_GESTURES', left), source('RIGHT_GESTURES', right), source('BOTTOM_MANDATORY_GESTURES', bottom), '        mSource=' + source('LEFT_GESTURES', '[0,0][1,1]').trim()].join('\n');

test('three-button navigation reserves no side zone, and the home strip is the mandatory bottom zone', () => {
  expect(parseSystemZones(dump('[0,0][0,2340]', '[1080,0][1080,2340]', '[0,2277][1080,2340]'))).toEqual({left: 0, right: 0, bottomMandatory: 63});
});

test('a gestural overlay reports the width of the Back zone on both sides', () => {
  expect(parseSystemZones(dump('[0,0][63,2340]', '[1017,0][1080,2340]', '[0,2277][1080,2340]'))).toEqual({left: 63, right: 63, bottomMandatory: 63});
});

test('a window dump without the gesture sources is refused instead of read as no zones', () => {
  expect(() => parseSystemZones('  Display: mDisplayId=0')).toThrow('shows no LEFT_GESTURES insets source');
});

test('the package in front is read from the focused window, and a dump with no focus has none', () => {
  expect(parseFocusedPackage('  mCurrentFocus=Window{611e1ce u0 com.android.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher}')).toBe('com.android.launcher3');
  expect(parseFocusedPackage('  mCurrentFocus=Window{3f2550 u0 app.lazysh.client/app.lazysh.client.MainActivity}')).toBe('app.lazysh.client');
  expect(parseFocusedPackage('  mCurrentFocus=null')).toBeUndefined();
});
