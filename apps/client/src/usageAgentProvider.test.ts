import {expect,it} from 'vitest';
import type {AccountUsageEntry} from './accountUsageReport';
import {agentProviders,entryForTarget,usageProviders,usageTarget} from './usageAgentProvider';

const entry=(id:string,name=id):AccountUsageEntry=>({id,name,shortName:id.slice(0,3),plan:null,status:'ready',stale:false,fetchedAt:null,rows:[],resetCredits:null});
const providerOf=(agent:string)=>usageTarget('follow','',agent)?.providerId;

it('lists every built-in provider once and maps agents only to listed providers',()=>{
  const ids=usageProviders.map(([id])=>id);
  expect(ids).toHaveLength(31);expect(new Set(ids).size).toBe(31);
  for(const [,provider] of agentProviders)expect(ids).toContain(provider);
});
it.each([
  // Herdr detector labels
  ['claude','anthropic'],['codex','openai'],['copilot','copilot'],['cursor','cursor'],['droid','droid'],['kimi','kimi'],['cline','cline'],['kiro','kiro'],['devin','devin'],
  ['agy','antigravity'],['grok','supergrok'],['hermes','nous'],['kilo','kilo'],['muse','muse-code'],['opencode','opencode-go'],
  // Companion hook-report names
  ['Claude Code','anthropic'],['Codex','openai'],['GitHub Copilot CLI','copilot'],['Cursor CLI','cursor'],['Droid','droid'],['Kimi CLI','kimi'],['Cline CLI','cline'],['OpenCode','opencode-go'],
  ['/usr/local/bin/claude','anthropic'],['Antigravity','antigravity'],['Command Code','commandcode'],
])('maps the agent %s to the %s account',(agent,provider)=>expect(providerOf(agent)).toBe(provider));
it.each(['pi','omp','gemini','amp','mastracode','qodercli','qwen','letta','maki','Gemini CLI','Aider','shell'])('has no account for %s, which shows no usage rather than another agent’s',agent=>{
  expect(usageTarget('follow','openai',agent)).toEqual({providerId:null,label:agent,agent:true});
});
it('does not confuse agents whose names only contain another name',()=>expect(providerOf('clauded')).toBeNull());
it('follows the agent only in follow mode and otherwise uses the chosen account or the host default',()=>{
  expect(usageTarget('follow','openai',null)).toEqual({providerId:'openai',label:'Codex',agent:false});
  expect(usageTarget('follow','',null)).toBeNull();
  expect(usageTarget('follow','openai',undefined)).toMatchObject({pending:true});
  expect(usageTarget('fixed','openai',undefined)).toEqual({providerId:'openai',label:'Codex',agent:false});
  expect(usageTarget('fixed','openai','claude')).toEqual({providerId:'openai',label:'Codex',agent:false});
  expect(usageTarget('fixed','','claude')).toBeNull();
  expect(usageTarget('follow','openai','claude')).toEqual({providerId:'anthropic',label:'Claude',agent:true});
});
it('finds the provider entry, its first named account, and never a different provider',()=>{
  const entries=[entry('openai'),entry('anthropic@work','Claude · work'),entry('anthropic@home'),entry('custom:acme')];
  const target=(providerId:string|null)=>({providerId,label:'x',agent:true});
  expect(entryForTarget(entries,target('openai'))?.id).toBe('openai');
  expect(entryForTarget(entries,target('anthropic'))?.id).toBe('anthropic@work');
  expect(entryForTarget([entry('anthropic'),entry('anthropic@work')],target('anthropic'))?.id).toBe('anthropic');
  expect(entryForTarget(entries,target('custom:acme'))?.id).toBe('custom:acme');
  expect(entryForTarget(entries,target('copilot'))).toBeUndefined();
  expect(entryForTarget(entries,target('anthropic_api'))).toBeUndefined();
  expect(entryForTarget(entries,target(null))).toBeUndefined();
});
