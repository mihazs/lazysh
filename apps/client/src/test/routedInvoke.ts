import {vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {hostBrowserSettings,notificationPolicy} from './agentBoardData';

const defaults:Record<string,unknown>={get_host_browser_settings:hostBrowserSettings,get_notification_policy:notificationPolicy};
/**
 * Answers each native command from its own queue (a function is called with the arguments when used, the last answer
 * repeats), so the host browser row's and the notification switches' reads never consume the answers meant for the
 * three switches. Both read as their defaults unless a test queues something else. Needs the test file's own
 * `vi.mock('@tauri-apps/api/core')`.
 */
export function answer(table:Record<string,unknown[]>) {
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    const queue=table[command];
    if(!queue)return defaults[command];
    const next=queue.length>1?queue.shift():queue[0];
    return typeof next==='function'?next(args):next;
  });
}
export const calls=(command:string)=>vi.mocked(invoke).mock.calls.filter(([name])=>name===command);
