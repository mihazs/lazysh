// @vitest-environment jsdom
import {invoke} from '@tauri-apps/api/core';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import ChatPanel from './ChatPanel';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

beforeEach(()=>access());
afterEach(()=>{cleanup();vi.mocked(invoke).mockReset();});

type Status='pending'|'in_progress'|'completed';
const update=(id:string,entries:[string,Status][])=>({id,role:'assistant',blocks:[{type:'tool_use',name:'TodoWrite',id,text:'{}',
  card:{kind:'plan',entries:entries.map(([text,status])=>({text,status}))}}]});
const page=(messages:unknown[])=>({schemaVersion:1,agent:'claude',view:'active_branch',messages,nextOffset:1,hasMore:false});
const prompt={id:'p',role:'user',blocks:[{type:'text',text:'Ship it'}]};
async function open(messages:unknown[]) {
  vi.mocked(invoke).mockResolvedValue(page(messages));
  render(<ChatPanel sessionId="host" shown bound={{agent:'claude',path:'/host/c.jsonl'}} timeline allowStage={false}/>);
  await act(async()=>{});
}

it('shows one chip that follows the latest of three plan updates and expands to the whole list',async()=>{
  await open([prompt,
    update('a',[['Read the code','in_progress'],['Write tests','pending'],['Ship','pending']]),
    update('b',[['Read the code','completed'],['Write tests','in_progress'],['Ship','pending']]),
    update('c',[['Read the code','completed'],['Write tests','completed'],['Ship','in_progress']])]);
  const chip=screen.getByRole('button',{name:/2 of 3/});
  expect(chip.textContent).toContain('Ship');
  expect(screen.queryByRole('region',{name:'Plan'})).toBeNull();
  fireEvent.click(chip);
  const plan=screen.getByRole('region',{name:'Plan'});
  expect(within(plan).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['DoneRead the code','DoneWrite tests','In progressShip']);
});

it('draws no chip without a plan',async()=>{
  await open([prompt,{id:'r',role:'assistant',blocks:[{type:'text',text:'Done'}]}]);
  expect(screen.getByText('Done')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/ of /})).toBeNull();
});
