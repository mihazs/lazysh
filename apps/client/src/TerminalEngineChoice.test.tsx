// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import TerminalEngineChoice from './TerminalEngineChoice';

const failure = vi.hoisted(() => ({recorded: undefined as string | undefined, refusal: undefined as string | undefined, again: undefined as string | undefined}));
vi.mock('./terminalBackends', () => ({backendRefusal: async () => failure.refusal, reprobeBackend: async () => failure.again, recordedNativeFailure: () => failure.recorded}));
afterEach(() => { cleanup(); failure.recorded = failure.refusal = undefined; });

const choice = (engine?: 'native' | 'xterm') => render(<TerminalEngineChoice engine={engine} screenReader={false} update={vi.fn()} />);

it('says that the native engine failed on this device, keeps it selectable so the user can try again, and says how long Auto keeps xterm.js', async () => {
  failure.recorded = 'failed: surface lost';
  choice();
  expect(await screen.findByText('The native engine failed on this device (surface lost). Auto keeps xterm.js until lazysh is updated; choose Native to try it again.')).toBeTruthy();
  expect((screen.getByRole('radio', {name: 'Native'}) as HTMLInputElement).disabled).toBe(false);
});

it('shows no failure when none is recorded, and the refusal when the engine cannot run', async () => {
  failure.refusal = 'no Vulkan';
  choice();
  expect(await screen.findByText('Native is turned off: the native engine cannot run here (no Vulkan).')).toBeTruthy();
  expect(screen.queryByText(/failed on this device/)).toBeNull();
  expect((screen.getByRole('radio', {name: 'Native'}) as HTMLInputElement).disabled).toBe(true);
});

it('asks the device again when the user checks, and offers Native once the device can draw', async () => {
  failure.refusal = 'the native engine cannot run here (no hardware GPU)';
  choice();
  expect(await screen.findByText(/Native is turned off/)).toBeTruthy();
  failure.again = undefined;
  fireEvent.click(screen.getByRole('button', {name: 'Check this device again'}));
  await vi.waitFor(() => expect((screen.getByRole('radio', {name: 'Native'}) as HTMLInputElement).disabled).toBe(false));
  expect(screen.queryByText(/Native is turned off/)).toBeNull();
});
