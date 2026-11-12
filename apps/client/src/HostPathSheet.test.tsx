// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import HostPathSheet from './HostPathSheet';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from './access';
import {t} from './i18n/core';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));

const path = '/work/app/src/main.rs';
let readFailure: unknown;
beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {transformCallback: () => 1, unregisterCallback: () => {}}});
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic host path fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'d'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  readFailure = undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'host_file_stat') return {path: (args as {path: string}).path, name: 'main.rs', kind: 'file', size: 12, link: null, actions: ['save', 'open']};
    if (command === 'read_file') { if (readFailure) throw readFailure; return 'fn main() {}'; }
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows the resolved path and line, views the file, copies the path and dismisses', async () => {
  const onCopy = vi.fn(), onClose = vi.fn();
  render(<HostPathSheet sessionId="ssh:one" path={path} line={3} onCopy={onCopy} onClose={onClose} />);
  const region = screen.getByRole('region', {name: t('terminalPathRegion')});
  expect(region.textContent).toContain(`${path} · ${t('terminalPathLine', {line: '3'})}`);
  fireEvent.click(screen.getByRole('button', {name: t('terminalViewFile')}));
  expect((await screen.findAllByText(/fn main/)).length).toBeGreaterThan(0);
  expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === 'read_file').map(call => call[1])).toEqual([{sessionId: 'ssh:one', path}]);
  fireEvent.click(screen.getByRole('button', {name: t('terminalCopyPath')}));
  expect(onCopy).toHaveBeenCalledWith(path);
  fireEvent.click(screen.getByRole('button', {name: t('terminalDismissPath')}));
  expect(onClose).toHaveBeenCalled();
});

it('reports a failed read instead of an empty viewer and offers no in-app view for images', async () => {
  readFailure = 'File is not valid UTF-8 text';
  const {rerender} = render(<HostPathSheet sessionId="ssh:one" path={path} onCopy={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', {name: t('terminalViewFile')}));
  expect((await screen.findByRole('alert')).textContent).toBe(readFailure);
  rerender(<HostPathSheet sessionId="ssh:one" path="/work/shot.png" onCopy={vi.fn()} onClose={vi.fn()} />);
  expect(screen.queryByRole('button', {name: t('terminalViewFile')})).toBeNull();
});
