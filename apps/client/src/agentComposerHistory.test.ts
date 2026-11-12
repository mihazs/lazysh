import {expect,it} from 'vitest';
import {promptsOf,recall,rememberPrompt,type Recall} from './agentComposerHistory';

const none: Recall = {index: null, text: ''};

it('walks back through the prompts from an empty composer and forward again to an empty one',()=>{
  const history = ['first', 'second', 'third'];
  const a = recall(history, none, '', 'up')!;
  expect(a).toEqual({index: 2, text: 'third'});
  const b = recall(history, a, 'third', 'up')!;
  expect(b).toEqual({index: 1, text: 'second'});
  expect(recall(history, {index: 0, text: 'first'}, 'first', 'up')).toEqual({index: 0, text: 'first'});
  expect(recall(history, b, 'second', 'down')).toEqual({index: 2, text: 'third'});
  expect(recall(history, {index: 2, text: 'third'}, 'third', 'down')).toEqual({index: null, text: ''});
});

it('never replaces text the person typed or edited, and does nothing without history',()=>{
  expect(recall(['a'], none, 'typing', 'up')).toBeUndefined();
  expect(recall(['a'], {index: 0, text: 'a'}, 'a edited', 'up')).toBeUndefined();
  expect(recall(['a'], {index: 0, text: 'a'}, 'a edited', 'down')).toBeUndefined();
  expect(recall([], none, '', 'up')).toBeUndefined();
  expect(recall(['a'], none, '', 'down')).toBeUndefined();
});

it('remembers each prompt once, newest last, per conversation and bounded',()=>{
  rememberPrompt('one', 'x');rememberPrompt('one', 'y');rememberPrompt('one', 'x');
  expect(promptsOf('one')).toEqual(['y', 'x']);
  expect(promptsOf('two')).toEqual([]);
  for (let index = 0; index < 80; index++) rememberPrompt('long', `p${index}`);
  expect(promptsOf('long')).toHaveLength(50);
  expect(promptsOf('long').at(-1)).toBe('p79');
});
