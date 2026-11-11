import type {EdgeHandlers} from './edgeGestures';

/** Test handlers that append every engine callback to `log`, so specs assert what fired and in what order. */
export const loggingHandlers = (log: string[]): EdgeHandlers => ({
  onStart: edge => log.push(`start:${edge}`),
  onProgress: (edge, progress) => log.push(`progress:${edge}:${progress.toFixed(2)}`),
  onCommit: edge => log.push(`commit:${edge}`),
  onCancel: edge => log.push(`cancel:${edge}`),
});
