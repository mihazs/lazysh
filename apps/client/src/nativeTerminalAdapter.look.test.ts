// @vitest-environment jsdom
import {describe, expect, it, vi} from 'vitest';
import {createHeadlessCore} from './xterm/nativeCoreHeadless';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {defaults, terminalPreferences} from './preferences';
import type {TerminalMountTarget} from './terminalAdapter';
import type {SurfaceLook} from './terminalSurfaceAnchor';

let anchors = 0;
const target = (surface?: string): TerminalMountTarget => {
  const element = document.createElement('div');
  element.id = `look-anchor-${anchors++}`;
  document.body.append(element);
  return {kind: 'native', anchorId: element.id, surface};
};

async function open(surface: string | null = 's1', look = vi.fn(async (_session: string, _look: SurfaceLook) => {})) {
  const adapter = await openNativeTerminalAdapter(createHeadlessCore(), {look});
  await adapter.attach(target(surface ?? undefined));
  return {adapter, look, preferences: terminalPreferences(defaults)};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('the look a native surface is drawn with', () => {
  it('is the preferences that decide colours, glyphs and cursor, sent to the surface of the session once for each change', async () => {
    const {adapter, look, preferences} = await open();
    adapter.applyPreferences(preferences);
    await settle();
    expect(look).toHaveBeenCalledTimes(1);
    const [session, sent] = look.mock.calls[0];
    expect(session).toBe('s1');
    expect(Object.keys(sent).sort()).toEqual(['boldColor', 'brightBold', 'cursorBlink', 'cursorStyle', 'fontFamily', 'fontSize', 'theme']);
    expect(sent).toMatchObject({fontSize: preferences.fontSize, fontFamily: preferences.fontFamily, cursorStyle: preferences.cursorStyle,
      cursorBlink: preferences.cursorBlink, brightBold: preferences.brightBold, theme: preferences.theme});

    // The same preferences as another object, and a change to what is not drawn, send nothing.
    adapter.applyPreferences({...preferences, theme: {...preferences.theme}});
    adapter.applyPreferences({...preferences, scrollbackLines: 999, optionAsMeta: true, screenReader: false});
    await settle();
    expect(look).toHaveBeenCalledTimes(1);

    // A pinch changes the size; the theme, the bold colour and the cursor are each a change too.
    adapter.applyPreferences({...preferences, fontSize: 20});
    adapter.applyPreferences({...preferences, fontSize: 20, theme: {...preferences.theme, background: '#fafafa'}, brightBold: false, boldColor: '#336699'});
    adapter.applyPreferences({...preferences, fontSize: 20, theme: {...preferences.theme, background: '#fafafa'}, brightBold: false, boldColor: '#336699', cursorStyle: 'underline', cursorBlink: false});
    await settle();
    expect(look.mock.calls.map(([, next]) => [next.fontSize, next.theme.background, next.brightBold, next.boldColor, next.cursorStyle, next.cursorBlink])).toEqual([
      [preferences.fontSize, preferences.theme.background, preferences.brightBold, undefined, preferences.cursorStyle, preferences.cursorBlink],
      [20, preferences.theme.background, preferences.brightBold, undefined, preferences.cursorStyle, preferences.cursorBlink],
      [20, '#fafafa', false, '#336699', preferences.cursorStyle, preferences.cursorBlink],
      [20, '#fafafa', false, '#336699', 'underline', false],
    ]);
  });

  it('reaches a surface that is attached after the preferences were applied, and only one that has a session', async () => {
    const {adapter, look, preferences} = await open(null);
    adapter.applyPreferences(preferences);
    await settle();
    expect(look).not.toHaveBeenCalled();
    await adapter.attach(target('s2'));
    await settle();
    expect(look.mock.calls.map(([session]) => session)).toEqual(['s2']);
  });

  it('is sent again when the shell refused it, and is not repeated once it was accepted', async () => {
    const look = vi.fn(async (_session: string, _look: SurfaceLook) => { if (look.mock.calls.length === 1) throw new Error('native_surface_locked'); });
    const {adapter, preferences} = await open('s1', look);
    adapter.applyPreferences(preferences);
    await settle();
    adapter.applyPreferences(preferences);
    await settle();
    expect(look).toHaveBeenCalledTimes(2);
    adapter.applyPreferences(preferences);
    await settle();
    expect(look).toHaveBeenCalledTimes(2);
  });

  it('is sent in the order the preferences changed, one command at a time', async () => {
    let release!: () => void;
    let running = 0, most = 0;
    const look = vi.fn(async (_session: string, _look: SurfaceLook) => {
      most = Math.max(most, ++running);
      if (look.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      running--;
    });
    const {adapter, preferences} = await open('s1', look);
    adapter.applyPreferences(preferences);
    adapter.applyPreferences({...preferences, fontSize: 18});
    adapter.applyPreferences({...preferences, fontSize: 22});
    await settle();
    expect(look).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(look.mock.calls.map(([, next]) => next.fontSize)).toEqual([preferences.fontSize, 18, 22]);
    expect(most).toBe(1);
  });

  it('is not sent after the terminal is disposed', async () => {
    const {adapter, look, preferences} = await open();
    await adapter.dispose();
    adapter.applyPreferences(preferences);
    await settle();
    expect(look).not.toHaveBeenCalled();
  });
});
