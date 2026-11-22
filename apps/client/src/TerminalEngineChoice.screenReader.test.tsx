// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';
import TerminalEngineChoice from './TerminalEngineChoice';

const registry = vi.hoisted(() => ({refusal: undefined as string | undefined}));
vi.mock('./terminalBackends', () => ({backendRefusal: async () => registry.refusal, recordedNativeFailure: () => undefined}));
afterEach(() => { cleanup(); registry.refusal = undefined; });

const native = () => screen.getByRole('radio', {name: 'Native'}) as HTMLInputElement;

it('asks again when the user returns to the app, so a screen reader turned on in Android\'s settings disables Native and turning it off enables it', async () => {
  render(<TerminalEngineChoice engine={undefined} screenReader={false} update={vi.fn()} />);
  await vi.waitFor(() => expect(native().disabled).toBe(false));

  registry.refusal = 'lacks accessibility';
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText('Native is turned off: a screen reader is active and the native engine cannot be read by it.')).toBeTruthy();
  expect(native().disabled).toBe(true);

  registry.refusal = undefined;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await vi.waitFor(() => expect(native().disabled).toBe(false));
  expect(screen.queryByText(/Native is turned off/)).toBeNull();
});
