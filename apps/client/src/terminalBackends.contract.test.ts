// @vitest-environment jsdom
import {beforeAll, describe, expect, it} from 'vitest';
import {stubMatchMedia} from './test/stubMatchMedia';
import type {TerminalBackendId} from './terminalAdapter';
import {runTerminalAdapterContract, type ContractHarness} from './terminalAdapter.contract';
import {capabilityCases, passedCases, runTerminalCapabilityContract, untestedCapabilities} from './terminalCapabilityTests';
import {registeredBackends} from './terminalBackends';
import {xtermContractHarness} from './xterm/contractHarness';
import {xtermCapabilities} from './xtermTerminalAdapter';

beforeAll(stubMatchMedia);

/** How to host each backend here (jsdom). A backend that is registered without an entry fails, so none is registered unchecked. */
const harnesses: Partial<Record<TerminalBackendId, ContractHarness>> = {xterm: xtermContractHarness};

const everyCase = Object.values(capabilityCases).flat();

describe('every registered backend passes the adapter contract for each capability it declares', () => {
  it('has a backend to check', () => { expect(registeredBackends().length).toBeGreaterThan(0); });

  for (const backend of registeredBackends()) describe(`registered backend ${backend.id}`, () => {
    const harness = harnesses[backend.id];
    it('has a contract harness', () => { expect(harness, `Add a harness for ${backend.id} before registering it.`).toBeDefined(); });
    if (!harness) return;
    runTerminalAdapterContract(backend.id, harness);
    runTerminalCapabilityContract(backend.id, harness);

    it('declares the capabilities its adapters report', async () => {
      const adapter = await harness.create();
      expect(adapter.capabilities).toEqual(backend.capabilities);
      await adapter.dispose();
    });

    it('has passed a case for each capability it declares, and every case the table names exists', ({task}) => {
      const passed = passedCases(task.suite!);
      expect(untestedCapabilities(backend.capabilities, passed)).toEqual([]);
      expect(everyCase.filter(title => !passed.has(title))).toEqual([]);
    });
  });
});

describe('the capability guard', () => {
  const allClaimed = {...xtermCapabilities, nativeRendering: true, canonicalMoshResize: true};

  it('refuses a backend that claims a capability nothing tests', () => {
    expect(untestedCapabilities(allClaimed, new Set(everyCase))).toEqual(['nativeRendering']);
    expect(untestedCapabilities({...allClaimed, nativeRendering: false}, new Set(everyCase))).toEqual([]);
  });

  it('refuses a capability once one of its cases is missing or has not passed', () => {
    const claimed = {...allClaimed, nativeRendering: false};
    for (const [capability, titles] of Object.entries(capabilityCases)) for (const title of titles) {
      expect(untestedCapabilities(claimed, new Set(everyCase.filter(other => other !== title))), `${capability}: ${title}`)
        .toContain(capability);
    }
  });

  it('does not ask for a test of a capability a backend does not claim', () => {
    const none = Object.fromEntries(Object.keys(capabilityCases).map(name => [name, false])) as typeof allClaimed;
    expect(untestedCapabilities(none, new Set())).toEqual([]);
  });
});
