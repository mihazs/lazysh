import {vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {hostBrowserSettings} from './agentBoardData';

/**
 * Answers each native command from its own queue (a function is called when used, the last answer repeats), so the
 * host browser row's reads never consume the answers meant for the three switches. The host browser row reads its
 * setting as off unless a test queues something else. Needs the test file's own `vi.mock('@tauri-apps/api/core')`.
 */
export function answer(table:Record<string,unknown[]>) {
  vi.mocked(invoke).mockImplementation(async command=>{
    const queue=table[command];
    if(!queue)return command==='get_host_browser_settings'?hostBrowserSettings:undefined;
    const next=queue.length>1?queue.shift():queue[0];
    return typeof next==='function'?next():next;
  });
}
export const calls=(command:string)=>vi.mocked(invoke).mock.calls.filter(([name])=>name===command);
