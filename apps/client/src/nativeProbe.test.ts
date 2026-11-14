import {describe, expect, it} from 'vitest';
import {createNativeProbe, type NativeEngineReport} from './nativeProbe';

function memory() {
  const items = new Map<string, string>();
  return {getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); }, items};
}
const asking = (report: NativeEngineReport | Error) => {
  let calls = 0;
  return {ask: async () => { calls++; if (report instanceof Error) throw report; return report; }, calls: () => calls};
};

describe('native engine probe', () => {
  it('passes only when the core is built in and a renderer can draw it', async () => {
    const both = createNativeProbe({ask: asking({core: true, renderer: true}).ask, storage: memory()});
    expect(await both.probe()).toEqual({ok: true});
  });

  it('fails with the reason the app gave, and with a reason of its own when it gave none', async () => {
    const reported = createNativeProbe({ask: asking({core: true, renderer: false, reason: 'No Vulkan device passed the render self-test.'}).ask, storage: memory()});
    expect(await reported.probe()).toEqual({ok: false, reason: 'No Vulkan device passed the render self-test.'});
    const noCore = createNativeProbe({ask: asking({core: false, renderer: true}).ask, storage: memory()});
    expect(await noCore.probe()).toEqual({ok: false, reason: 'The native terminal core is not built into this app.'});
    const noRenderer = createNativeProbe({ask: asking({core: true, renderer: false}).ask, storage: memory()});
    expect(await noRenderer.probe()).toEqual({ok: false, reason: 'This build has no native terminal renderer.'});
  });

  it('asks once per device and costs nothing the next start, until a re-probe', async () => {
    const storage = memory(), app = asking({core: true, renderer: false, reason: 'no renderer'});
    const first = createNativeProbe({ask: app.ask, storage, fingerprint: 'build-1'});
    await first.probe(); await first.probe();
    expect(app.calls()).toBe(1);
    expect((await first.last())?.cached).toBe(false);
    // A new start of the same build reads the stored answer.
    const second = createNativeProbe({ask: app.ask, storage, fingerprint: 'build-1'});
    expect(await second.probe()).toEqual({ok: false, reason: 'no renderer'});
    expect(app.calls()).toBe(1);
    expect((await second.last())).toMatchObject({cached: true});
    // A new build or webview asks again; so does an explicit re-probe.
    await createNativeProbe({ask: app.ask, storage, fingerprint: 'build-2'}).probe();
    expect(app.calls()).toBe(2);
    expect((await second.reprobe()).cached).toBe(false);
    expect(app.calls()).toBe(3);
  });

  it('turns an app that cannot answer, or answers too late, into a failed probe and keeps nothing', async () => {
    const storage = memory();
    const absent = createNativeProbe({ask: asking(new Error('command terminal_native_probe not found')).ask, storage});
    expect(await absent.probe()).toEqual({ok: false, reason: 'The native engine could not be probed: command terminal_native_probe not found'});
    const slow = createNativeProbe({ask: () => new Promise(() => {}), storage, budgetMs: 20});
    expect(await slow.probe()).toEqual({ok: false, reason: 'The native engine could not be probed: the probe did not answer within 20 ms'});
    expect((await slow.last())!.costMs).toBeGreaterThanOrEqual(15);
    expect(storage.items.size).toBe(0);
  });

  it('probes anyway on a device that cannot keep its answer', async () => {
    const broken = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); }};
    const app = asking({core: true, renderer: true});
    const probe = createNativeProbe({ask: app.ask, storage: broken});
    expect(await probe.probe()).toEqual({ok: true});
    expect((await probe.reprobe()).result).toEqual({ok: true});
  });
});
