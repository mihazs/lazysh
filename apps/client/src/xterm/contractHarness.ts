import {Terminal} from '@xterm/xterm';
import type {ContractHarness} from '../terminalAdapter.contract';
import {openNativeTerminalAdapter} from '../nativeTerminalAdapter';
import {XtermTerminalAdapter} from '../xtermTerminalAdapter';
import {createHeadlessCore} from './nativeCoreHeadless';

/** The xterm backend over a real xterm.js terminal that is not opened in a DOM: 20 columns by 5 rows and 200 lines of scrollback unless told otherwise. */
export const createXtermAdapter = ({cols = 20, rows = 5, scrollback = 200} = {}) =>
  new XtermTerminalAdapter(new Terminal({cols, rows, scrollback, allowProposedApi: false}));

/** Hosts the xterm backend in jsdom for the adapter contract. */
export const xtermContractHarness: ContractHarness = {
  create: () => createXtermAdapter(),
  target: () => { const element = document.createElement('div'); document.body.append(element); return {kind: 'dom', element}; },
};

let anchors = 0;
/** Hosts the native adapter in jsdom for the adapter contract over the stand-in core on headless xterm.js; the real core runs it in `nativeTerminalAdapter.realCore.test.ts`. */
export const nativeContractHarness: ContractHarness = {
  create: () => openNativeTerminalAdapter(createHeadlessCore()),
  target: () => { const element = document.createElement('div'); element.id = `native-contract-anchor-${anchors++}`; document.body.append(element); return {kind: 'native', anchorId: element.id}; },
};
