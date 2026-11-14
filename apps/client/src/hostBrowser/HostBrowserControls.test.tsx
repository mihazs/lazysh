// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { t, uiI18n } from '../i18n/core';
import { HostBrowserControls } from './HostBrowserControls';
import type { Blocked, Navigation, PageDialog, View } from './model';

afterEach(async () => { cleanup(); await uiI18n.changeLanguage('en'); });

const tabs = [
  { id: 'a', title: 'Docs', url: 'https://docs.example.com/start' },
  { id: 'b', title: '<img src=x onerror=alert(1)>', url: 'http://localhost:3000/' },
];
const idle: View = { tabs, activeId: 'a', canGoBack: true, canGoForward: false, loading: false };
const quiet = () => ({ navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn(), stop: vi.fn(), activate: vi.fn(), newTab: vi.fn(), closeTab: vi.fn(), answer: vi.fn() });

function show(view: View = idle, extra: { dialog?: PageDialog; blocked?: Blocked[]; open?: boolean; navigation?: ReturnType<typeof quiet> } = {}) {
  const navigation = extra.navigation ?? quiet();
  for (const call of Object.values(navigation)) call.mockResolvedValue(undefined);
  const onDismiss = vi.fn(), onOpenOnDevice = vi.fn();
  const view_ = render(<HostBrowserControls view={view} dialog={extra.dialog ?? null} blocked={extra.blocked ?? []} navigation={navigation as Navigation}
    onDismiss={onDismiss} onOpenOnDevice={extra.open === false ? undefined : onOpenOnDevice} />);
  return { navigation, onDismiss, onOpenOnDevice, ...view_ };
}
const address = () => screen.getByRole('textbox', { name: t('hostBrowserAddress') }) as HTMLInputElement;
const typeAddress = (text: string) => { fireEvent.focus(address()); fireEvent.change(address(), { target: { value: text } }); fireEvent.submit(address().closest('form')!); };

it('shows the address of the shown page and opens a typed one, normalized', () => {
  const { navigation } = show();
  expect(address().value).toBe('https://docs.example.com/start');
  typeAddress('example.org/path');
  expect(navigation.navigate).toHaveBeenCalledWith('https://example.org/path');
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each([['javascript:alert(1)', 'javascript'], ['data:text/html,x', 'data'], ['file:///etc/passwd', 'file'], ['chrome://settings', 'chrome']])('refuses %s with a reason and does not navigate', (typed, scheme) => {
  const { navigation } = show();
  typeAddress(typed);
  expect(screen.getByRole('alert').textContent).toBe(t('hostBrowserRefusedScheme', { scheme }));
  expect(address().getAttribute('aria-invalid')).toBe('true');
  expect(navigation.navigate).not.toHaveBeenCalled();
  fireEvent.change(address(), { target: { value: 'example.org' } });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('says why an empty or malformed address is not opened', () => {
  show();
  typeAddress('   ');
  expect(screen.getByRole('alert').textContent).toBe(t('hostBrowserRefusedEmpty'));
  typeAddress('not a host');
  expect(screen.getByRole('alert').textContent).toBe(t('hostBrowserRefusedInvalid'));
});

it('goes back, forward and reloads, and offers stop instead of reload while the page loads', () => {
  const first = show();
  expect((screen.getByRole('button', { name: t('hostBrowserForward') }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserBack') }));
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserReload') }));
  expect([first.navigation.back, first.navigation.reload].map(call => call.mock.calls.length)).toEqual([1, 1]);
  first.unmount();
  const loading = show({ ...idle, canGoBack: false, canGoForward: true, loading: true });
  expect(screen.queryByRole('button', { name: t('hostBrowserReload') })).toBeNull();
  expect((screen.getByRole('button', { name: t('hostBrowserBack') }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserForward') }));
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserStop') }));
  expect([loading.navigation.forward, loading.navigation.stop].map(call => call.mock.calls.length)).toEqual([1, 1]);
});

it('lists the tabs with their title and address as text, and switches, opens and closes them', () => {
  const { navigation, container } = show();
  const list = screen.getByRole('list', { name: t('hostBrowserTabs') });
  expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  // A page's title is text: nothing it contains becomes an element.
  expect(container.querySelector('img')).toBeNull();
  expect(within(list).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  expect(within(list).getByText('http://localhost:3000/')).toBeTruthy();
  const current = within(list).getByText('Docs').closest('button')!;
  expect(current.getAttribute('aria-current')).toBe('page');
  fireEvent.click(within(list).getByText('<img src=x onerror=alert(1)>'));
  expect(navigation.activate).toHaveBeenCalledWith('b');
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserCloseTab', { title: 'Docs' }) }));
  expect(navigation.closeTab).toHaveBeenCalledWith('a');
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserNewTab') }));
  expect(navigation.newTab).toHaveBeenCalledOnce();
});

it('names a tab with no title by its address, or says it is untitled', () => {
  show({ ...idle, tabs: [{ id: 'c', title: '', url: 'https://x.test/' }, { id: 'd', title: '', url: '' }], activeId: 'c' });
  expect(screen.getByRole('button', { name: t('hostBrowserCloseTab', { title: 'https://x.test/' }) })).toBeTruthy();
  expect(screen.getByRole('button', { name: t('hostBrowserCloseTab', { title: t('hostBrowserUntitled') }) })).toBeTruthy();
});

it('tells the person when the browser did not do what was asked', async () => {
  const navigation = quiet();
  show(idle, { navigation });
  navigation.reload.mockRejectedValue(new Error('gone'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('hostBrowserReload') })); });
  expect(screen.getByRole('alert').textContent).toBe(t('hostBrowserActionFailed'));
});

it('opens a loopback page as a Preview at once, and any other page only after a confirmation that names its host', () => {
  const local = show({ ...idle, activeId: 'b' });
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserOpenOnDevice') }));
  expect(local.onOpenOnDevice).toHaveBeenCalledWith({ kind: 'preview', port: 3000, address: '127.0.0.1', path: '/' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  local.unmount();

  const remote = show();
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserOpenOnDevice') }));
  const dialog = screen.getByRole('alertdialog', { name: t('hostBrowserOpenConfirm', { host: 'docs.example.com' }) });
  expect(remote.onOpenOnDevice).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: t('appCancel') }));
  expect(remote.onOpenOnDevice).not.toHaveBeenCalled();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserOpenOnDevice') }));
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserOpen') }));
  expect(remote.onOpenOnDevice).toHaveBeenCalledWith({ kind: 'external', host: 'docs.example.com', url: 'https://docs.example.com/start' });
});

it('does not offer Open on this device without a way to do it, or for a page that is not on the web', () => {
  show(idle, { open: false });
  expect(screen.queryByRole('button', { name: t('hostBrowserOpenOnDevice') })).toBeNull();
  cleanup();
  show({ ...idle, tabs: [{ id: 'a', title: '', url: 'about:blank' }] });
  expect(screen.queryByRole('button', { name: t('hostBrowserOpenOnDevice') })).toBeNull();
});

it('shows a page dialog as the page\'s text, answers it and keeps the page\'s markup inert', () => {
  const alert = show(idle, { dialog: { kind: 'alert', message: '<b>Hello</b>\nsecond line', defaultPrompt: '' } });
  const dialog = screen.getByRole('alertdialog', { name: t('hostBrowserDialogAlert') });
  expect(within(dialog).getByText(t('hostBrowserDialogUntrusted'))).toBeTruthy();
  expect(dialog.querySelector('b')).toBeNull();
  expect(dialog.querySelector('blockquote')!.textContent).toBe('<b>Hello</b>\nsecond line');
  fireEvent.click(within(dialog).getByRole('button', { name: t('hostBrowserDialogOk') }));
  expect(alert.navigation.answer).toHaveBeenCalledWith(true, undefined);
});

it('declines a question with Cancel or Escape, accepts it with OK, and sends a prompt\'s text', () => {
  const question = show(idle, { dialog: { kind: 'confirm', message: 'Delete everything?', defaultPrompt: '' } });
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserDialogOk') }));
  expect(question.navigation.answer.mock.calls).toEqual([[false, undefined], [true, undefined]]);
  question.unmount();
  const prompt = show(idle, { dialog: { kind: 'prompt', message: 'Name?', defaultPrompt: 'Ada' } });
  const field = screen.getByRole('textbox', { name: t('hostBrowserDialogAnswer') }) as HTMLInputElement;
  expect(field.value).toBe('Ada');
  fireEvent.change(field, { target: { value: 'Grace' } });
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserDialogOk') }));
  expect(prompt.navigation.answer).toHaveBeenCalledWith(true, 'Grace');
  prompt.unmount();
  const leaving = show(idle, { dialog: { kind: 'beforeunload', message: '', defaultPrompt: '' } });
  expect(screen.getByRole('alertdialog', { name: t('hostBrowserDialogLeave') }).querySelector('blockquote')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserDialogStay') }));
  fireEvent.click(screen.getByRole('button', { name: t('hostBrowserDialogLeaveButton') }));
  expect(leaving.navigation.answer.mock.calls).toEqual([[false, undefined], [true, undefined]]);
});

it('reports what the browser refused to do, once per kind, until it is dismissed', () => {
  const { onDismiss } = show(idle, { blocked: ['download', 'fileChooser'] });
  const notices = screen.getByRole('status');
  expect(within(notices).getAllByRole('paragraph').map(notice => notice.firstChild!.textContent)).toEqual([t('hostBrowserBlockedDownload'), t('hostBrowserBlockedFileChooser')]);
  fireEvent.click(within(notices).getAllByRole('button', { name: t('hostBrowserDismiss') })[0]);
  expect(onDismiss).toHaveBeenCalledWith('download');
});

it('is translated, and never translates the page\'s own text', async () => {
  show(idle, { dialog: { kind: 'alert', message: 'Reload {{now}}', defaultPrompt: '' }, blocked: ['download'] });
  for (const locale of ['pt-BR', 'es']) {
    await act(async () => { await uiI18n.changeLanguage(locale); });
    expect(t('hostBrowserBack')).not.toBe('Back');
    expect(screen.getByRole('button', { name: t('hostBrowserBack') })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: t('hostBrowserAddress') })).toBeTruthy();
    expect(screen.getByRole('alertdialog', { name: t('hostBrowserDialogAlert') })).toBeTruthy();
    expect(screen.getByText(t('hostBrowserBlockedDownload'))).toBeTruthy();
    expect(screen.getByText('Reload {{now}}')).toBeTruthy();
    expect(screen.getByText('Docs')).toBeTruthy();
  }
});
