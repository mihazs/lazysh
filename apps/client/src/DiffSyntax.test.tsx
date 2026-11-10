// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import DiffSyntax from './DiffSyntax';
import {diffLines} from './RepositoryPanel';

afterEach(cleanup);
it('highlights both sides within each hunk without interpreting file text as markup',async()=>{
  const rows=diffLines('@@ -1,2 +1,2 @@\n /* comment\n-old */ const x = "<img src=x>";\n+new */ const y = "<script>";');
  const {container}=render(<DiffSyntax path="file.ts" rows={rows}>{highlighted=><div>{rows.map((row,index)=><div key={index}><pre>{highlighted?.left[index]??row.left}</pre><pre>{highlighted?.right[index]??row.right}</pre></div>)}</div>}</DiffSyntax>);
  fireEvent.click(screen.getByRole('button',{name:'Highlight syntax'}));
  await waitFor(()=>expect(container.querySelector('.hljs-keyword')).not.toBeNull());
  const lines=container.querySelectorAll('pre');
  expect(lines[4].textContent).toBe('old */ const x = "<img src=x>";');
  expect(lines[5].textContent).toBe('new */ const y = "<script>";');
  expect(lines[4].querySelector('.hljs-comment')?.textContent).toContain('old */');
  expect(container.querySelector('img,script')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Show plain text'}));
  expect(container.querySelector('.hljs-keyword')).toBeNull();
});

it('does not reuse highlights after the diff changes and bounds work for large diffs',async()=>{
  const old=diffLines('@@ -1 +1 @@\n-const oldValue = 1;\n+const replacement = 2;');
  const show=(rows:ReturnType<typeof diffLines>)=><DiffSyntax path="file.ts" rows={rows}>{nodes=><pre>{nodes?.left[1]??rows[1]?.left}</pre>}</DiffSyntax>;
  const {container,rerender}=render(show(old));fireEvent.click(screen.getByRole('button',{name:'Highlight syntax'}));
  await waitFor(()=>expect(container.querySelector('.hljs-keyword')).not.toBeNull());
  const next=diffLines('@@ -1 +1 @@\n-<script>new</script>\n+other');rerender(show(next));
  expect(container.querySelector('pre')?.textContent).toBe('<script>new</script>');
  expect(container.querySelector('script')).toBeNull();
  rerender(show(diffLines('@@ -1 +1 @@\n-'+ 'x'.repeat(100001))));
  expect(screen.queryByRole('button',{name:'Highlight syntax'})).toBeNull();
});
