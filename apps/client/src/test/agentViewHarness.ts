import {act,cleanup,fireEvent,within} from '@testing-library/react';
import {afterEach,beforeEach,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {chatFollowAccess as access} from './chatFollowAccess';

/** The commands the mocked host received, by name, with their arguments. */
export const calls=(name:string)=>vi.mocked(invoke).mock.calls.filter(([command])=>command===name).map(([,args])=>args);
export const advance=async(ms:number)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
/** A fresh mocked host, fake timers and an open access lease for every test; call it once at the top of a test file that mocks `invoke`. */
export function useAgentViewHarness() {
  beforeEach(()=>{localStorage.clear();vi.useFakeTimers();vi.mocked(invoke).mockReset();access();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
  afterEach(()=>{cleanup();vi.useRealTimers();});
}
export const ask=(questions:object[])=>[{id:'p',role:'user',blocks:[{type:'text',text:'Ask me'}]},{id:'a',role:'assistant',blocks:[{type:'tool_use',id:'q1',name:'AskUserQuestion',text:'{}',card:{kind:'question',questions}}]}];
export const color={question:'Pick a color',multiple:false,options:[{label:'Red'},{label:'Blue'}]};
/** Types `text` in the free-text field of an open question card and sends it. */
export async function typeOwnAnswer(card:HTMLElement,text:string,click:(name:string)=>Promise<void>) {
  fireEvent.change(within(card).getByLabelText('Or type your own answer'),{target:{value:text}});
  await click('Send typed answer');
}
