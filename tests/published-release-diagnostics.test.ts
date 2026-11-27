import {expect,test} from 'bun:test';
import {EventEmitter} from 'node:events';
import type {request} from 'node:https';
import {json} from '../apps/client/published-native-e2e/release';

type Reply={status:number;headers?:Record<string,string>;body?:string;error?:Error};
// A controlled transport: the reader's own logic runs against a scripted reply, never the network.
const transport=(reply:Reply|Error):typeof request=>((_url:unknown,_options:unknown,answer:(response:EventEmitter&{statusCode:number;headers:Record<string,string>;destroy():void})=>void)=>{
  const req=Object.assign(new EventEmitter(),{end(){
    queueMicrotask(()=>{
      if(reply instanceof Error){req.emit('error',reply);return;}
      const response=Object.assign(new EventEmitter(),{statusCode:reply.status,headers:reply.headers??{},destroy(){}});
      answer(response);
      if(reply.body!==undefined)response.emit('data',Buffer.from(reply.body));
      response.emit('end');
    });
  }});
  return req;
}) as never;
const failure=async(reply:Reply|Error)=>String(await json('releases/latest',transport(reply)).then(()=>'no failure',error=>error.message));
const code=Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com secret-host'),{code:'ENOTFOUND'});

test('a valid public metadata response is parsed',async()=>{
  expect(await json('releases/latest',transport({status:200,body:'{"id":7}'}))).toEqual({id:7});
});

test.each([
  ['a request error names its system code only',code,'network error ENOTFOUND'],
  ['a timeout is its own category',Object.assign(new Error('x'),{name:'TimeoutError'}),'timeout'],
  ['a rate limit names its status',{status:403,body:'{"message":"rate limit secret"}'},'HTTP status 403'],
  ['a server error names its status',{status:503},'HTTP status 503'],
  ['an oversize body is reported as such',{status:200,body:'x'.repeat(262_145)},'response too large'],
  ['a compressed body is reported as such',{status:200,headers:{'content-encoding':'gzip'}},'unsupported content encoding'],
] as const)('%s and leaks no response detail',async(_name,reply,category)=>{
  const message=await failure(reply as Reply|Error);
  expect(message).toBe(`Direct public GitHub evidence request failed: ${category}`);
});

test('a non-JSON body is reported as a decode failure without its content',async()=>{
  expect(await failure({status:200,body:'<html>secret</html>'})).toBe('Direct public GitHub metadata is invalid: response is not JSON');
});
