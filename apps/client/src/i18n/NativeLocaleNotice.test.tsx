// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NativeLocaleNotice} from './NativeLocaleNotice';
afterEach(cleanup);
it('explains the unsettled native write and disables retry until actual ownership ends',()=>{
  const retry=vi.fn();const view=render(<NativeLocaleNotice state={{mode:'native',phase:'error',error:'write',writerPending:true}} retry={retry}/>);
  expect(screen.getByRole('alert').textContent).toContain('still finishing');
  const button=screen.getByRole<HTMLButtonElement>('button',{name:'Retry language check'});
  expect(button.disabled).toBe(true);fireEvent.click(button);expect(retry).not.toHaveBeenCalled();
  view.rerender(<NativeLocaleNotice state={{mode:'native',phase:'error',error:'write',writerPending:false}} retry={retry}/>);
  expect(button.disabled).toBe(false);fireEvent.click(button);expect(retry).toHaveBeenCalledTimes(1);
});
