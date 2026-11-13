import {act} from '@testing-library/react';

/** Opens every folded activity row of the timeline, as tapping its summary does: its rows are drawn once it has been opened. */
export async function openFolds(root: ParentNode = document) {
  await act(async () => {
    root.querySelectorAll<HTMLDetailsElement>('details.agent-turn-activity').forEach(details => {details.open = true; details.dispatchEvent(new Event('toggle'));});
  });
}
