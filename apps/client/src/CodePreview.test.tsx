// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CodePreview from './CodePreview';
import {useLayoutEffect,useRef} from 'react';
afterEach(cleanup);

it('highlights source through text/span nodes and keeps markup inert', async () => {
  const source = 'const text = "<img src=secret onerror=alert(1)>";';
  const { container } = render(<CodePreview path="example.ts" text={source} />);
  fireEvent.click(screen.getByRole('button', { name: 'Highlight syntax' }));
  await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull());
  expect(container.querySelector('img, script, iframe')).toBeNull();
  expect(container.querySelector('code')?.textContent).toBe(source);
  expect(container.querySelector('pre')?.tabIndex).toBe(0);
});

it.each([['unknown.ext', 'plain',false], ['boundary.ts', 'x'.repeat(100000),true], ['large.ts', 'x'.repeat(100001),false]] as const)('bounds syntax availability for %s', (path,text,available) => {
  const {container}=render(<CodePreview path={path} text={text}/>);
  expect(screen.queryByRole('button')!==null).toBe(available);
  expect(container.querySelector('code')?.textContent).toBe(text);
});

it('ignores a syntax import that resolves after the selected source changes',async()=>{
  const {container,rerender}=render(<CodePreview path="old.ts" text="const obsolete = 1;"/>);
  fireEvent.click(screen.getByRole('button',{name:'Highlight syntax'}));
  rerender(<CodePreview path="new.unknown" text={'<script>new literal</script>'}/>);
  await act(async()=>{await import('lowlight');});
  expect(container.querySelector('code')?.textContent).toBe('<script>new literal</script>');
  expect(container.querySelector('[class^=hljs],script')).toBeNull();
});

it('never commits old highlighted text when a selected path receives new contents',async()=>{
  const committed:string[]=[];
  function Observed({text}:{text:string}){
    const root=useRef<HTMLDivElement>(null);
    useLayoutEffect(()=>{committed.push(root.current!.querySelector('code')!.textContent!);},[text]);
    return <div ref={root}><CodePreview path="same.ts" text={text}/></div>;
  }
  const {container,rerender}=render(<Observed text="const oldText = 1;"/>);
  fireEvent.click(screen.getByRole('button',{name:'Highlight syntax'}));
  await waitFor(()=>expect(container.querySelector('.hljs-keyword')).not.toBeNull());
  rerender(<Observed text="let newText = 2;"/>);
  expect(committed.at(-1)).toBe('let newText = 2;');
  await waitFor(()=>expect(container.querySelector('code')?.textContent).toBe('let newText = 2;'));
});
