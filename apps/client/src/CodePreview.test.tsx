// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CodePreview from './CodePreview';
afterEach(cleanup);

it('highlights source through text/span nodes and keeps markup inert', async () => {
  const source = 'const text = "<img src=secret onerror=alert(1)>";';
  const { container } = render(<CodePreview path="example.ts" text={source} />);
  fireEvent.click(screen.getByRole('button', { name: 'Highlight syntax' }));
  await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull());
  expect(container.querySelector('img, script, iframe')).toBeNull();
  expect(container.querySelector('code')?.textContent).toBe(source);
});
