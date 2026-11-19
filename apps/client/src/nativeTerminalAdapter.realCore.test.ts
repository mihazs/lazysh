// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {nativeCapabilities, openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {runTerminalAdapterContract} from './terminalAdapter.contract';
import {passedCases, untestedCapabilities} from './terminalCapabilityTests';
import {openStdioCore} from './test/stdioNativeCore';

// The harness is built from the runtime crate with Zig (`cargo build --example control_stdio`), which only the herdr-native
// CI job has: it sets this variable, and every other run skips the file.
const binary = process.env.LAZYSH_CONTROL_STDIO;
let anchors = 0;

describe.skipIf(!binary)('NativeTerminalAdapter over the real core', () => {
  runTerminalAdapterContract('native (control plane over libghostty-vt)', {
    create: async () => openNativeTerminalAdapter(await openStdioCore(binary!)),
    target: () => {
      const element = document.createElement('div');
      element.id = `real-core-anchor-${anchors++}`;
      document.body.append(element);
      return {kind: 'native', anchorId: element.id};
    },
  });

  it('has passed a case for each capability the adapter declares', ({task}) => {
    expect(untestedCapabilities(nativeCapabilities, passedCases(task.suite!))).toEqual([]);
  });
});
