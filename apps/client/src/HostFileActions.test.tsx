// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import HostFileActions from './HostFileActions';
import {FilesPanel} from './SessionTools';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from './access';
import {t,uiI18n} from './i18n/core';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));

type Stat = {path: string; name: string; kind: string; size: number; link: string | null; actions: string[]};
const file = (over: Partial<Stat> = {}): Stat => ({path: '/home/mía/relatório final.pdf', name: 'relatório final.pdf', kind: 'file', size: 2_500_000, link: null, actions: ['save', 'open'], ...over});
let stat: Stat;
let download: (args: {progress: {onmessage: (value: unknown) => void}; transferId: string}) => Promise<unknown>;
let deliver: (action: string) => Promise<unknown>;
const calls = () => vi.mocked(invoke).mock.calls.map(call => [call[0], call[1] as Record<string, unknown>] as const);
const named = (command: string) => calls().filter(call => call[0] === command).map(call => call[1]);

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {configurable: true, value: {transformCallback: () => 1, unregisterCallback: () => {}}});
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic file transfer fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  stat = file();
  download = async ({progress}) => { progress.onmessage({bytes: 1_250_000, total: 2_500_000}); progress.onmessage({bytes: 2_500_000, total: 2_500_000}); return {name: stat.name, size: stat.size}; };
  deliver = async action => ({location: action === 'save' ? '/home/mía/Downloads/relatório final (1).pdf' : null});
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as never as Record<string, never>;
    if (command === 'host_file_stat') return stat;
    if (command === 'host_file_download') return download(input as never);
    if (command === 'host_file_deliver') return deliver(String(input.action));
    if (command === 'host_file_cancel') return;
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(async () => { cleanup(); vi.clearAllMocks(); await uiI18n.changeLanguage('en'); });
const mount = (session = 'ssh:transfer') => render(<HostFileActions sessionId={session} path={stat.path} />);
const press = async (name: string) => { fireEvent.click(await screen.findByRole('button', {name})); };

it('downloads with progress, saves without overwriting and discards the staged copy', async () => {
  mount();
  await press(t('filesDownload'));
  await screen.findByText(t('filesSaved', {location: '/home/mía/Downloads/relatório final (1).pdf'}));
  const [request] = named('host_file_download');
  expect(request).toMatchObject({sessionId: 'ssh:transfer', path: stat.path, followLink: false, allowLarge: false});
  expect(String(request.transferId)).toMatch(/^[0-9a-f-]{36}$/);
  expect(named('host_file_deliver')).toEqual([{sessionId: 'ssh:transfer', transferId: request.transferId, action: 'save'}]);
  await waitFor(() => expect(named('host_file_cancel')).toContainEqual({sessionId: 'ssh:transfer', transferId: request.transferId}));
});

it('shows progress while the copy streams and offers Cancel that stops it and keeps nothing', async () => {
  let reject!: (reason: unknown) => void;
  download = ({progress}) => new Promise((_resolve, fail) => { reject = fail; progress.onmessage({bytes: 1_250_000, total: 2_500_000}); });
  mount();
  await press(t('filesDownload'));
  await screen.findByText(t('filesDownloading', {name: stat.name, done: '1.2 MiB', total: '2.4 MiB'}));
  expect(screen.getByRole('progressbar', {name: t('filesProgress')})).toHaveProperty('value', 1_250_000);
  for (const name of [t('filesDownload'), t('filesOpenWith')]) expect(screen.getByRole('button', {name})).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', {name: t('filesCancel')}));
  const [request] = named('host_file_download');
  await waitFor(() => expect(named('host_file_cancel')).toContainEqual({sessionId: 'ssh:transfer', transferId: request.transferId}));
  await act(async () => { reject({kind: 'transfer_cancelled', message: 'Download cancelled. No file was kept.'}); });
  expect((await screen.findByRole('status')).textContent).toBe(t('filesDownloadCancelled'));
  expect(named('host_file_deliver')).toEqual([]);
});

it('asks before following a symbolic link and before a large file, and never before a small plain file', async () => {
  stat = file({link: '/srv/data/real.pdf', size: 80 * 1024 * 1024});
  mount();
  await press(t('filesDownload'));
  const prompt = await screen.findByRole('group', {name: t('filesConfirmDownload')});
  expect(prompt.textContent).toContain(t('filesLinkConfirm', {name: stat.name, target: '/srv/data/real.pdf'}));
  expect(prompt.textContent).toContain(t('filesLargeConfirm', {name: stat.name, size: '80 MiB'}));
  expect(named('host_file_download')).toEqual([]);
  fireEvent.click(screen.getByRole('button', {name: t('filesCancel')}));
  expect(screen.queryByRole('group', {name: t('filesConfirmDownload')})).toBeNull();
  expect(named('host_file_download')).toEqual([]);
  await press(t('filesDownload'));
  fireEvent.click(await screen.findByRole('button', {name: t('filesContinue')}));
  await screen.findByText(t('filesSaved', {location: '/home/mía/Downloads/relatório final (1).pdf'}));
  expect(named('host_file_download')[0]).toMatchObject({followLink: true, allowLarge: true});
});

it('opens with another app and keeps the copy for it', async () => {
  mount();
  await press(t('filesOpenWith'));
  await screen.findByText(t('filesOpened'));
  const [first] = named('host_file_download');
  expect(named('host_file_deliver')).toEqual([{sessionId: 'ssh:transfer', transferId: first.transferId, action: 'open'}]);
  expect(named('host_file_cancel')).toEqual([]);
  cleanup();
  expect(named('host_file_cancel')).toEqual([]);
});

it('offers Share only where the device supports it', async () => {
  mount();
  await screen.findByRole('button', {name: t('filesDownload')});
  expect(screen.queryByRole('button', {name: t('filesShare')})).toBeNull();
  cleanup();
  stat = file({actions: ['save', 'open', 'share']});
  mount();
  await press(t('filesShare'));
  await screen.findByText(t('filesShared'));
  expect(named('host_file_deliver')).toEqual([expect.objectContaining({action: 'share'})]);
  cleanup();
  stat = file({actions: []});
  mount();
  await waitFor(() => expect(screen.queryByRole('button', {name: t('filesDownload')})).toBeNull());
  expect(screen.queryByRole('button', {name: t('filesOpenWith')})).toBeNull();
});

it.each([
  ['a host failure keeps its own wording', () => { download = async () => { throw {kind: 'file_changed', message: 'The file got shorter while it was downloading.'}; }; }, 'The file got shorter while it was downloading.'],
  ['a folder is refused with a local message', () => { stat = file({kind: 'directory'}); }, t('filesNotFile')],
  ['a refused open reports why', () => { deliver = async () => { throw {kind: 'open_refused', message: 'lazysh does not open programs or scripts. Download the file instead.'}; }; }, 'lazysh does not open programs or scripts. Download the file instead.'],
])('%s', async (_name, arrange, message) => {
  arrange();
  mount();
  await press(message.includes('programs') ? t('filesOpenWith') : t('filesDownload'));
  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(named('host_file_deliver').length).toBe(message.includes('programs') ? 1 : 0);
  if (message.includes('programs')) expect(named('host_file_cancel').length).toBe(1);
});

it('is translated and keeps byte sizes in the interface language', async () => {
  await uiI18n.changeLanguage('pt-BR');
  stat = file({size: 80 * 1024 * 1024});
  mount();
  await press(t('filesDownload'));
  expect((await screen.findByRole('group', {name: t('filesConfirmDownload')})).textContent).toContain('80 MiB');
  expect(screen.getByRole('button', {name: 'Continuar'})).toBeTruthy();
});

it('the Files panel selects a file, previews it and offers the actions for that exact path', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as never as Record<string, string>;
    if (command === 'list_directory') return [{name: 'relatório final.txt', isDir: false, size: 12}];
    if (command === 'read_file') return `contents of ${input.path}`;
    if (command === 'host_file_stat') return file({path: input.path, name: 'relatório final.txt'});
    throw new Error(`Unexpected command ${command}`);
  });
  render(<FilesPanel sessionId="ssh:panel" />);
  fireEvent.click(await screen.findByRole('button', {name: /relatório final\.txt/}));
  await screen.findByText('contents of ./relatório final.txt');
  expect(await screen.findByRole('button', {name: t('filesDownload')})).toBeTruthy();
  expect(named('host_file_stat')).toEqual([{sessionId: 'ssh:panel', path: './relatório final.txt'}]);
});
