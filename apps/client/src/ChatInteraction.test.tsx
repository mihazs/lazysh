// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import ChatPanel from './ChatPanel';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {interactionPages as pages} from '../e2e/fixtures/interactionPages';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

beforeEach(()=>{vi.mocked(invoke).mockReset();access();});
afterEach(cleanup);
const clone=<T,>(value:T):T=>structuredClone(value);
async function open(page:unknown,agent:'claude'|'codex'|'opencode'='claude',view='conversation') {
  const openTerminal=vi.fn();
  vi.mocked(invoke).mockResolvedValue(page);
  render(<ChatPanel sessionId="host" onOpenTerminal={openTerminal}/>);
  if(agent!=='claude')fireEvent.change(screen.getByLabelText('Agent'),{target:{value:agent}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/source'}});
  if(agent==='opencode')fireEvent.change(screen.getByLabelText('Transcript session ID'),{target:{value:'ses_fixture'}});
  fireEvent.change(screen.getByLabelText('View'),{target:{value:view}});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  return openTerminal;
}
const entries=(card:HTMLElement)=>within(card).getAllByRole('listitem').map(item=>item.textContent);

it('shows a waiting Claude question with its options and sends the user to the terminal',async()=>{
  const openTerminal=await open(pages.claudeWaiting);
  expect(screen.getByText('Agent is waiting for your answer')).toBeTruthy();
  expect(entries(screen.getByRole('region',{name:'Plan'}))).toEqual(['DoneRecord the fixture shapes','In progressChoose a layout','PendingWrite the reader tests']);
  const question=screen.getByRole('region',{name:'Question'});
  expect(within(question).getByRole('group',{name:'Layout: Which fixture layout should the reader use?'})).toBeTruthy();
  expect(entries(question)).toEqual(['FlatOne records file per agent.','NestedOne directory per agent.']);
  expect(within(question).getByRole('note').textContent).toBe("No answer is recorded yet. Answer in the terminal: Chat cannot choose options in the agent's prompt.");
  expect(within(question).queryByRole('radio')).toBeNull();
  fireEvent.click(within(question).getByRole('button',{name:'Open terminal'}));
  expect(openTerminal).toHaveBeenCalledOnce();
});

it('marks recorded answers, renders the approved plan as Markdown and reports an idle turn',async()=>{
  await open(pages.claudeIdle);
  expect(screen.getByText('Agent is idle')).toBeTruthy();
  const question=screen.getByRole('region',{name:'Question'});
  expect(within(question).getByRole('note').textContent).toMatch(/^An answer is recorded\./);
  expect(within(question).queryByRole('button')).toBeNull();
  const proposed=screen.getByRole('region',{name:'Proposed plan'});
  expect(within(proposed).getByRole('heading',{name:'Fixture plan'})).toBeTruthy();
  expect(entries(proposed)).toEqual(['Add nested fixtures.','Cover each reader.']);
  // The raw tool call stays available beside each card.
  expect(screen.getAllByText('AskUserQuestion')).toHaveLength(1);
});

it('renders the Codex plan-mode item and records-view plan and question cards',async()=>{
  await open(pages.codexIdle,'codex');
  expect(within(screen.getByRole('region',{name:'Proposed plan'})).getByRole('heading',{name:'Fixture plan'})).toBeTruthy();
  expect(screen.getByText('Agent is idle')).toBeTruthy();
  cleanup();
  await open(pages.codexRecords,'codex','records');
  const plan=screen.getByRole('region',{name:'Plan'});
  expect(within(plan).getByText('Fixture work in order.')).toBeTruthy();
  expect(within(screen.getByRole('region',{name:'Question'})).getByRole('note').textContent).toMatch(/^An answer is recorded\./);
  // Records pages are partial, so no turn state is shown.
  expect(screen.queryByText(/^Agent (is|turn|state)/)).toBeNull();
});

it('shows OpenCode cancelled todos and multiple-choice questions',async()=>{
  await open(pages.opencodeIdle,'opencode');
  expect(entries(screen.getByRole('region',{name:'Plan'}))).toEqual(['DoneRecord the fixture shapes','In progressChoose a layout','CancelledDrop the legacy layout']);
  expect(within(screen.getByRole('region',{name:'Question'})).getByText('More than one option can be chosen.')).toBeTruthy();
});

it('keeps an absent state unknown',async()=>{
  const page=clone(pages.claudeIdle) as {activity?:string};
  delete page.activity;
  await open(page);
  expect(screen.getByText('Agent state unknown')).toBeTruthy();
});

it.each([
  ['an unknown activity',(page:any)=>{page.activity='thinking';},'Invalid recorded agent state.'],
  ['activity on a records page',(page:any)=>{page.view='record_stream';},'Invalid recorded agent state.'],
  ['an unknown plan status',(page:any)=>{page.messages[1].blocks[0].card.entries[0].status='blocked';},'Invalid recorded plan or question.'],
  ['a card on a result block',(page:any)=>{page.messages[2].blocks[0].card=page.messages[1].blocks[0].card;},'Invalid recorded plan or question.'],
  ['an unexpected card field',(page:any)=>{page.messages[3].blocks[0].card.answer='Flat';},'Invalid recorded plan or question.'],
])('rejects %s',async(_name,edit,message)=>{
  const page=clone(pages.claudeWaiting);
  edit(page);
  await open(page);
  expect(screen.getByRole('alert').textContent).toBe(message);
  expect(screen.queryByRole('region',{name:'Question'})).toBeNull();
});

it('rejects cards from agents whose transcripts do not carry them',async()=>{
  const page={...clone(pages.codexRecords),agent:'pi'};
  vi.mocked(invoke).mockResolvedValue(page);
  render(<ChatPanel sessionId="host"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'pi'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/source'}});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  expect(screen.getByRole('alert').textContent).toBe('Invalid recorded plan or question.');
});

it('shows each recorded Claude API failure as an error card with the next step, and a mere mention as text',async()=>{
  await open(pages.claudeErrors);
  const cards=screen.getAllByRole('alert');
  expect(cards).toHaveLength(4);
  expect(cards.map(card=>within(card).getByRole('heading').textContent)).toEqual(Array(4).fill('The agent could not continue'));
  // The record's own text (with the reset time) is the cause; the card adds what to do.
  expect(within(cards[0]).getByText(/resets 7pm/)).toBeTruthy();
  expect(within(cards[0]).getByText(/Wait for it to reset/)).toBeTruthy();
  expect(within(cards[1]).getByText(/Check the host's network/)).toBeTruthy();
  expect(within(cards[2]).getByText(/Shorten or change the prompt/)).toBeTruthy();
  expect(within(cards[3]).getByText(/Check the terminal/)).toBeTruthy();
  // An error value the reader has no fixture for, and a plain message that quotes an error, stay ordinary text.
  expect(screen.getByText('API Error: 529 Synthetic overload')).toBeTruthy();
  expect(screen.getByText('Prompt is too long is a message the API can return.')).toBeTruthy();
});

it('rejects an error card on another agent or on a tool block',async()=>{
  const page=clone(pages.claudeErrors);
  page.agent='codex';
  vi.mocked(invoke).mockResolvedValue(page);
  render(<ChatPanel sessionId="host"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'codex'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/host/source'}});
  fireEvent.change(screen.getByLabelText('View'),{target:{value:'conversation'}});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  expect(screen.queryByRole('heading',{name:'The agent could not continue'})).toBeNull();
});
