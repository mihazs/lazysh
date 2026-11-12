import type {StatusItem} from './agentBackgroundWork';

/** What a request to stop one task of the Agent view says, and when there is a task to ask about. Pure.
 * Claude Code's TUI stops a task from its task list with keys that depend on what is on screen; lazysh does not drive those keys.
 * It sends the agent one fixed sentence naming the task id its launch result gave, and the agent ends the task with its own
 * `TaskStop` tool; the end is then read back from the recorded `TaskStop` result like any other. */
const identifier = /^[A-Za-z0-9_-]{1,64}$/;

/** Background commands, monitors and sub-agents. A workflow is left out: `TaskStop` was not verified on one. */
export const stoppable = (item: StatusItem) => item.state === 'running' && item.kind !== 'workflow' && !!item.taskId && identifier.test(item.taskId);

export const stopMessage = (taskId: string) => `Stop background task ${taskId} with the TaskStop tool, then reply only "stopped".`;

/** A stop not seen in the record this long after the request is shown as not confirmed. */
export const STOP_CONFIRM_MS = 90_000;
