import {expect,it} from 'vitest';
import {matchSlash,promptMode,slashCommands,slashText} from './agentSlashCommands';

it('offers commands only while the first word is being typed, filtered by prefix',()=>{
  expect(matchSlash('claude','/')?.map(command=>command.name)).toEqual(slashCommands.claude.map(command=>command.name));
  expect(matchSlash('claude','/Co')?.map(command=>command.name)).toEqual(['compact','context','cost','config']);
  expect(matchSlash('claude','/compact ')).toBeUndefined();
  expect(matchSlash('claude','run /compact')).toBeUndefined();
  expect(matchSlash('claude','/nothing')).toBeUndefined();
  expect(matchSlash('claude','')).toBeUndefined();
  expect(matchSlash('codex','/Ne')?.map(command=>command.name)).toEqual(['new']);
});

it('inserts the command with a trailing space and marks the ones that open a terminal dialog',()=>{
  const [model]=matchSlash('claude','/mod')!;
  expect(slashText(model)).toBe('/model ');
  expect(model.picker).toBe(true);
  expect(matchSlash('claude','/comp')![0].picker).toBeUndefined();
  for(const commands of Object.values(slashCommands))expect(new Set(commands.map(command=>command.name)).size).toBe(commands.length);
});

it('names the mode a leading character selects in the agent\'s own prompt box',()=>{
  expect(promptMode('claude','!ls')).toBe('bash');
  expect(promptMode('codex','!ls')).toBe('bash');
  expect(promptMode('claude','#remember this')).toBe('memory');
  expect(promptMode('codex','#remember this')).toBeUndefined();
  expect(promptMode('claude','ls !')).toBeUndefined();
});
