// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import AgentThinking,{turnThinking} from './AgentThinking';

afterEach(cleanup);
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11, 10, 0, seconds)).toISOString();
const think = (seconds: number | undefined, ...texts: string[]) => ({timestamp: seconds === undefined ? undefined : at(seconds), blocks: texts.map(text => ({type: 'thinking', text}))});
const prompt = {timestamp: at(0), blocks: [{type: 'text', text: 'Go'}]};
const tool = {timestamp: at(9), blocks: [{type: 'tool_use'}]};

it('sums the time before each thinking message and keeps every paragraph', () => {
  const turn = {prompt, activity: [think(4, 'First idea.'), tool, think(15, 'Second idea.', 'Third idea.')], answer: {timestamp: at(20), blocks: [{type: 'text', text: 'Done'}]}};
  expect(turnThinking(turn)).toEqual({paragraphs: ['First idea.', 'Second idea.', 'Third idea.'], milliseconds: 4000 + 6000});
  render(<AgentThinking turn={turn} />);
  expect(screen.getByText('Thought for 10 s')).toBeTruthy();
  fireEvent.click(screen.getByText('Thought for 10 s'));
  expect(['First idea.', 'Second idea.', 'Third idea.'].map(text => screen.getByText(text).tagName)).toEqual(['P', 'P', 'P']);
});

it('says only Thinking without timestamps and draws nothing for redacted or absent thinking', () => {
  const {container, rerender} = render(<AgentThinking turn={{activity: [think(undefined, 'Hmm.')]}} />);
  expect(screen.getByText('Thinking')).toBeTruthy();
  rerender(<AgentThinking turn={{activity: [think(5, '   ')], answer: {blocks: [{type: 'text', text: 'x'}]}}} />);
  expect(container.textContent).toBe('');
});

it('formats a long thought as minutes and seconds', () => {
  render(<AgentThinking turn={{prompt: {timestamp: at(0), blocks: []}, activity: [think(83, 'Long.')]}} />);
  expect(screen.getByText('Thought for 1:23')).toBeTruthy();
});
