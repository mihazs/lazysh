// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AgentPanel, parseSnapshot } from './AgentPanel';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn()}));
vi.mock('./ApprovalPanel', () => ({default: () => null}));
const session = { sessionId: 'a', agent: 'Claude Code', project: '/work', state: 'needs_attention', updatedAt: '2026-10-24T19:30:00Z', summary: 'Permission requested', paneId: '%1', eventCount: 2 };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('agent activity', () => {
  it('accepts versioned snapshots and rejects malformed host data', () => {
    expect(parseSnapshot({ schemaVersion: 1, sessions: [session] })).toEqual([session]);
    for (const value of [null, { schemaVersion: 2, sessions: [] }, { schemaVersion: 1, sessions: [{ ...session, state: 'approved' }] }, { schemaVersion: 1, sessions: [{ ...session, eventCount: -1 }] }]) expect(() => parseSnapshot(value)).toThrow();
  });
  it('shows actual host events without an unimplemented approval action', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockResolvedValue({ schemaVersion: 1, sessions: [session] });
    render(<AgentPanel sessionId="ssh-one" />);
    expect(await screen.findByText('Permission requested')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('agent_snapshot', { sessionId: 'ssh-one' });
    expect(screen.queryByRole('button', { name: /allow|approve/i })).toBeNull();
  });
  it('explains setup when the host companion is unavailable', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValue({ message: 'lazysh-agent: command not found' });
    render(<AgentPanel sessionId="ssh-one" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Connect your agents.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('get_companion_settings',expect.anything());
    expect(screen.queryByRole('region',{name:'Host companion settings'})).toBeNull();
  });
  it('verifies the new host companion before loading settings after a session change',async()=>{
    const {invoke}=await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockImplementation((command,args)=>{
      if(command==='agent_snapshot')return args && 'sessionId' in args && args.sessionId==='new-host'?new Promise(()=>{}):Promise.resolve({schemaVersion:1,sessions:[]});
      return Promise.resolve({schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true});
    });
    const {rerender}=render(<AgentPanel sessionId="old-host"/>);
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('get_companion_settings',{sessionId:'old-host'}));
    rerender(<AgentPanel sessionId="new-host"/>);
    expect(invoke).not.toHaveBeenCalledWith('get_companion_settings',{sessionId:'new-host'});
    expect(screen.queryByRole('region',{name:'Host companion settings'})).toBeNull();
  });
});
