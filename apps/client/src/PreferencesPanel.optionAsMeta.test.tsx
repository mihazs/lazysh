// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent} from '@testing-library/react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {mountPreferences} from './test/preferencesPanel';
import {defaults, getPreferences, savePreferences} from './preferences';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(), isTauri: vi.fn()}));
beforeEach(() => { savePreferences({...defaults, optionAsMeta: true}); vi.mocked(isTauri).mockReturnValue(true); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const NAME = 'Use Option as Meta on macOS';
/** Opens the Keyboard page and lets the `local_capability` reply land. */
async function keyboardPage() {
  const page = mountPreferences('Keyboard and gestures');
  await act(async () => {});
  return page;
}

describe('Option as Meta scope', () => {
  it('shows the control and saves its toggle only when the app reports macOS', async () => {
    vi.mocked(invoke).mockResolvedValue({platform: 'macos'});
    const page = await keyboardPage();
    const setting = page.getByRole<HTMLInputElement>('checkbox', {name: NAME});
    expect(setting.checked).toBe(true);
    fireEvent.click(setting);
    expect(getPreferences().optionAsMeta).toBe(false);
  });

  it.each(['windows', 'linux', 'android', 'ios'])('hides the control on %s and keeps the saved choice', async platform => {
    vi.mocked(invoke).mockResolvedValue({platform});
    const page = await keyboardPage();
    expect(page.queryByRole('checkbox', {name: NAME})).toBeNull();
    expect(getPreferences().optionAsMeta).toBe(true);
  });

  it('keeps the control hidden until the app answers', async () => {
    let answer!: (value: {platform: string}) => void;
    vi.mocked(invoke).mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const page = mountPreferences('Keyboard and gestures');
    expect(page.queryByRole('checkbox', {name: NAME})).toBeNull();
    await act(async () => answer({platform: 'macos'}));
    expect(page.getByRole('checkbox', {name: NAME})).toBeTruthy();
  });

  it.each([
    ['a reply without a platform', () => vi.mocked(invoke).mockResolvedValue({available: false})],
    ['a failed request', () => vi.mocked(invoke).mockRejectedValue(new Error('unavailable'))],
  ])('keeps the control when the platform is unknown after %s', async (_name, arrange) => {
    arrange();
    const page = await keyboardPage();
    expect(page.getByRole('checkbox', {name: NAME})).toBeTruthy();
  });

  it('keeps the control outside the app without asking it', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const page = await keyboardPage();
    expect(page.getByRole('checkbox', {name: NAME})).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('local_capability', expect.anything(), expect.anything());
  });
});
