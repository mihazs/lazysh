// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import PreviewPanel from './PreviewPanel';

const navigation = vi.hoisted(() => ({ loaded: undefined as (() => void) | undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));
// This file tests panel staging against an explicitly controlled child lifecycle.
// PreviewPanel.test and PreviewFrame.test continue exercising the real iframe.
vi.mock('./PreviewFrame', () => ({ default: ({ onNavigate }: { onNavigate?: () => void }) => {
  navigation.loaded = onNavigate;
  return null;
} }));
const preview = { id: 'forward-one', remotePort: 5173, remoteAddress: '127.0.0.1', localPort: 41234, url: 'http://127.0.0.1:41234/' };
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); navigation.loaded = undefined; });

async function loadPreview() {
  vi.mocked(invoke).mockResolvedValue([preview]);
  render(<PreviewPanel sessionId="ssh-one" />);
  await waitFor(() => expect(navigation.loaded).toBeTypeOf('function'));
  act(() => navigation.loaded!());
}

it('stages a page note only after an explicit user action following initial navigation', async () => {
  const staged = vi.fn();
  window.addEventListener('lazysh-prompt-draft', staged);
  try {
    await loadPreview();
    fireEvent.change(screen.getByLabelText('Page path'), { target: { value: '/login' } });
    fireEvent.change(screen.getByLabelText('Element selector (optional)'), { target: { value: '#submit' } });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Increase contrast' } });
    expect(staged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stage note in prompt' }));
    expect(staged).toHaveBeenCalledOnce();
    const detail = (staged.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.sessionId).toBe('ssh-one');
    expect(detail.text).toContain('Page: /login\nElement: #submit\nComment: Increase contrast');
    expect(invoke).not.toHaveBeenCalledWith('write_stdin', expect.anything(), expect.anything());
  } finally { window.removeEventListener('lazysh-prompt-draft', staged); }
});

it('clears stale page and element context on later navigation without staging another note', async () => {
  const staged = vi.fn();
  window.addEventListener('lazysh-prompt-draft', staged);
  try {
    await loadPreview();
    fireEvent.change(screen.getByLabelText('Page path'), { target: { value: '/login' } });
    fireEvent.change(screen.getByLabelText('Element selector (optional)'), { target: { value: '#submit' } });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Increase contrast' } });

    act(() => navigation.loaded!());
    expect(screen.getByLabelText('Page path')).toHaveProperty('value', '/');
    expect(screen.getByLabelText('Element selector (optional)')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Comment')).toHaveProperty('value', 'Increase contrast');
    expect(staged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stage note in prompt' }));
    expect(staged).toHaveBeenCalledOnce();
    expect(screen.getByText('Note added to the prompt draft. Review it before sending.')).toBeTruthy();
    act(() => navigation.loaded!());
    expect(screen.queryByText('Note added to the prompt draft. Review it before sending.')).toBeNull();
    expect(staged).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Review the new page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stage note in prompt' }));
    expect(staged).toHaveBeenCalledTimes(2);
    expect((staged.mock.calls[1][0] as CustomEvent).detail.text).toContain('Page: /\nElement: (page)\nComment: Review the new page');
    expect(invoke).not.toHaveBeenCalledWith('write_stdin', expect.anything(), expect.anything());
  } finally { window.removeEventListener('lazysh-prompt-draft', staged); }
});
