// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {createLocaleController,PreferenceStorageError} from './nativeLocale';
import type {UiLanguage} from './core';

function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const status=(choice:UiLanguage='pt-BR',revision='0')=>({nativeAuthority:true,choice,resolvedLocale:choice==='system'?'es-MX':choice,revision});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

it('bootstrap reads native authority once without sending stale browser preferences',async()=>{
  const pending=deferred<unknown>();const invoke=vi.fn(()=>pending.promise);const commit=vi.fn();
  const controller=createLocaleController({native:true,invoke:invoke as never,commit});
  controller.start();controller.start();await Promise.resolve();
  expect(invoke.mock.calls).toEqual([['ui_locale_status']]);expect(commit).not.toHaveBeenCalled();
  pending.resolve(status());await pending.promise;await Promise.resolve();
  expect(controller.snapshot().mode).toBe('native');expect(commit).toHaveBeenCalledWith('pt-BR',true);
});

it('serializes explicit changes with the last native revision, never freshening a queued abandoned action',async()=>{
  const first=deferred<unknown>();const second=deferred<unknown>();
  const invoke=vi.fn().mockResolvedValueOnce(status()).mockImplementationOnce(()=>first.promise).mockImplementationOnce(()=>second.promise);
  const commit=vi.fn();const controller=createLocaleController({native:true,invoke,commit});
  await controller.refresh();
  const a=controller.change('en');const b=controller.change('es');await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(2);
  const revision='12345678-1234-1234-1234-123456789abc';first.resolve(status('en',revision));await a;await Promise.resolve();
  expect(invoke).toHaveBeenLastCalledWith('ui_locale_set',{choice:'es',expectedRevision:revision});
  second.resolve(status('es','22345678-1234-1234-1234-123456789abc'));await b;
  expect(commit).toHaveBeenLastCalledWith('es',true);
  await expect(controller.change('en',()=>false)).rejects.toThrow();expect(invoke).toHaveBeenCalledTimes(3);
});

it('failed native persistence keeps an explicit error until a fresh getter reconciles actual state',async()=>{
  const invoke=vi.fn().mockResolvedValueOnce(status()).mockRejectedValueOnce(new Error('native failed')).mockResolvedValueOnce(status('es'));
  const commit=vi.fn();const controller=createLocaleController({native:true,invoke,commit});
  await controller.refresh();await expect(controller.change('en')).rejects.toThrow();
  expect(controller.snapshot()).toMatchObject({mode:'native',phase:'error',error:'write'});
  await expect(controller.change('es')).rejects.toThrow();expect(invoke).toHaveBeenCalledTimes(2);
  await controller.refresh();expect(controller.snapshot()).toMatchObject({phase:'ready',native:{choice:'es'}});
  expect(commit).toHaveBeenLastCalledWith('es',true);
});

it('read failure never selects a saved JavaScript choice or invokes a setter',async()=>{
  const invoke=vi.fn().mockRejectedValue(new Error('unavailable'));const commit=vi.fn();
  const controller=createLocaleController({native:true,invoke,commit});
  await expect(controller.refresh()).rejects.toThrow();
  expect(controller.snapshot()).toMatchObject({mode:'unknown',phase:'error',error:'read'});
  expect(commit).not.toHaveBeenCalled();expect(invoke.mock.calls).toEqual([['ui_locale_status']]);
});

it('frontend-authority platforms preserve synchronous preference changes without native setters',async()=>{
  const commit=vi.fn();const invoke=vi.fn();const controller=createLocaleController({native:false,invoke,commit});
  const changed=controller.change('pt-BR');expect(commit).toHaveBeenCalledWith('pt-BR',false);await changed;
  expect(invoke).not.toHaveBeenCalled();
});

it('unsupported native capability remains frontend-owned',async()=>{
  const invoke=vi.fn().mockResolvedValue({nativeAuthority:false});const commit=vi.fn();
  const controller=createLocaleController({native:true,invoke,commit});await controller.refresh();
  await controller.change('es');expect(commit.mock.calls).toEqual([['es',false]]);expect(invoke).toHaveBeenCalledTimes(1);
});

it('a timed-out read permits retry and its late reply cannot overwrite the newer native snapshot',async()=>{
  vi.useFakeTimers();const stale=deferred<unknown>();const commit=vi.fn();
  const invoke=vi.fn().mockImplementationOnce(()=>stale.promise).mockResolvedValueOnce(status('es'));
  const controller=createLocaleController({native:true,invoke,commit});
  const old=controller.refresh().catch(()=>{});await vi.advanceTimersByTimeAsync(5000);await old;
  expect(controller.snapshot().phase).toBe('error');await controller.refresh();
  stale.resolve(status('en'));await stale.promise;await Promise.resolve();
  expect(commit.mock.calls).toEqual([['es',true]]);expect(controller.snapshot().native?.choice).toBe('es');
});

it('a slow admitted write retains ownership, rejects further choices and expires queued intent without replay',async()=>{
  vi.useFakeTimers();const held=deferred<unknown>();
  const invoke=vi.fn().mockResolvedValueOnce(status()).mockImplementationOnce(()=>held.promise);
  const controller=createLocaleController({native:true,invoke,commit:vi.fn()});await controller.refresh();
  const first=controller.change('en');const queued=controller.change('es').catch(()=>{});
  await vi.advanceTimersByTimeAsync(5000);
  expect(controller.snapshot()).toMatchObject({phase:'error',error:'write'});
  await expect(controller.change('pt-BR')).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(2);
  held.resolve(status('en','12345678-1234-1234-1234-123456789abc'));await first;await queued;
  expect(controller.snapshot().native?.choice).toBe('en');expect(invoke).toHaveBeenCalledTimes(2);
});

it('retry fails promptly while an unknown native write owns the queue instead of waiting forever behind it',async()=>{
  vi.useFakeTimers();const held=deferred<unknown>();
  const invoke=vi.fn().mockResolvedValueOnce(status()).mockImplementationOnce(()=>held.promise);
  const controller=createLocaleController({native:true,invoke,commit:vi.fn()});await controller.refresh();
  const writing=controller.change('en');await vi.advanceTimersByTimeAsync(5000);
  const pending=controller.snapshot();let settled=false;
  const retry=controller.refresh().then(()=>{settled=true;},()=>{settled=true;});
  await vi.advanceTimersByTimeAsync(20000);const settledBeforeWrite=settled;const before=invoke.mock.calls.length;
  held.resolve(status('en','12345678-1234-1234-1234-123456789abc'));await writing;await retry;
  expect(settledBeforeWrite).toBe(true);expect(before).toBe(2);
  expect(pending).toMatchObject({phase:'error',writerPending:true});
  expect(controller.snapshot()).not.toMatchObject({writerPending:true});
});

it('frontend-only persistence failures remain settings errors without a native retry state',async()=>{
  const invoke=vi.fn();
  const controller=createLocaleController({native:false,invoke,commit:()=>{throw new Error('Owned quota failure');}});
  await expect(controller.change('es')).rejects.toBeInstanceOf(PreferenceStorageError);
  expect(controller.snapshot()).toEqual({mode:'frontend',phase:'ready'});
  expect(invoke).not.toHaveBeenCalled();
});
