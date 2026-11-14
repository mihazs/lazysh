// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {FilesPanel} from './SessionTools';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from './access';
import {t} from './i18n/core';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));

const home = '/home/mía';
const folders: Record<string, {name: string; isDir: boolean; size: number}[]> = {
  '.': [{name: 'start.txt', isDir: false, size: 1}],
  [home]: [{name: 'dev', isDir: true, size: 0}],
  [`${home}/dev/my project`]: [{name: 'ünï 世界.md', isDir: false, size: 7}],
};
const lists = () => vi.mocked(invoke).mock.calls.filter(call => call[0] === 'list_directory').map(call => (call[1] as {path: string}).path);

beforeEach(() => {
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic files home fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const {path} = args as {path: string};
    if (command === 'host_home') return home;
    if (command === 'list_directory') {
      if (!(path in folders)) throw new Error(`No such file: ${path}`);
      return folders[path];
    }
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function go(path: string) {
  fireEvent.change(screen.getByLabelText(t('filesDirectory')), {target: {value: path}});
  fireEvent.click(screen.getByRole('button', {name: t('filesOpen')}));
}

it('opens ~ paths in the host home and shows the resolved absolute path', async () => {
  render(<FilesPanel sessionId="ssh:home-files" />);
  await screen.findByText('start.txt');
  expect(invoke).not.toHaveBeenCalledWith('host_home', expect.anything(), expect.anything());
  await go('~/dev/my project');
  await screen.findByText('ünï 世界.md');
  expect((screen.getByLabelText(t('filesDirectory')) as HTMLInputElement).value).toBe(`${home}/dev/my project`);
  await go('~');
  await screen.findByText('dev');
  expect((screen.getByLabelText(t('filesDirectory')) as HTMLInputElement).value).toBe(home);
  expect(lists()).toEqual(['.', `${home}/dev/my project`, home]);
  expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === 'host_home')).toHaveLength(1);
});

it('says why another user\'s home and a missing directory do not open', async () => {
  render(<FilesPanel sessionId="ssh:home-files-errors" />);
  await screen.findByText('start.txt');
  await go('~root/.ssh');
  expect((await screen.findByRole('alert')).textContent).toBe(t('filesHomeUser'));
  expect(lists()).toEqual(['.']);
  await go('~/nowhere');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(`No such file: ${home}/nowhere`));
});
