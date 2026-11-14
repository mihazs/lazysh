import {expect,it} from 'vitest';
import {listingPath,matchEntries,mentionAt,mentionText} from './agentFileMention';

const file=(name:string,isDir=false)=>({name,isDir,size:0});

it('finds the mention at the caret, from the start of a word, with its folder and prefix',()=>{
  expect(mentionAt('@',1)).toEqual({start:0,dir:'',prefix:''});
  expect(mentionAt('look at @src/ap',15)).toEqual({start:8,dir:'src/',prefix:'ap'});
  expect(mentionAt('look at @src/ap and more',15)).toEqual({start:8,dir:'src/',prefix:'ap'});
  expect(mentionAt('a\n@docs/x/re',12)).toEqual({start:2,dir:'docs/x/',prefix:'re'});
  expect(mentionAt('mail me at a@b.c',16)).toBeUndefined();
  expect(mentionAt('no mention here',5)).toBeUndefined();
  expect(mentionAt('@done and moved on',12)).toBeUndefined();
});

it('refuses paths that leave the agent folder before anything is listed',()=>{
  for(const query of ['@../','@src/../x','@/etc/','@a\\b','@./x','@src/./'])expect(mentionAt(query,query.length),query).toBeUndefined();
  expect(mentionAt('@a\u0007b',4)).toBeUndefined();
});

it('lists the folder below the agent folder, whatever the trailing slashes',()=>{
  expect(listingPath('/work/app',{start:0,dir:'',prefix:''})).toBe('/work/app');
  expect(listingPath('/work/app/',{start:0,dir:'src/ui/',prefix:'x'})).toBe('/work/app/src/ui');
  expect(listingPath('/',{start:0,dir:'',prefix:''})).toBe('/');
});

it('filters by prefix without case, hides dot files unless asked, drops names that cannot be mentioned and caps the list',()=>{
  const entries=[file('src',true),file('README.md'),file('.env'),file('readme.txt'),file('a b.txt'),...Array.from({length:30},(_,index)=>file(`r${index}`))];
  expect(matchEntries(entries,{start:0,dir:'',prefix:'re'}).map(entry=>entry.name)).toEqual(['README.md','readme.txt']);
  expect(matchEntries(entries,{start:0,dir:'',prefix:'.'}).map(entry=>entry.name)).toEqual(['.env']);
  expect(matchEntries(entries,{start:0,dir:'',prefix:''}).map(entry=>entry.name)).not.toContain('.env');
  expect(matchEntries(entries,{start:0,dir:'',prefix:''}).map(entry=>entry.name)).not.toContain('a b.txt');
  expect(matchEntries(entries,{start:0,dir:'',prefix:'r'})).toHaveLength(20);
});

it('replaces a mention with a closed file or an open folder',()=>{
  const mention={start:3,dir:'src/',prefix:'ap'};
  expect(mentionText(mention,file('app.ts'))).toBe('@src/app.ts ');
  expect(mentionText(mention,file('app',true))).toBe('@src/app/');
});
