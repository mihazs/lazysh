import {Terminal} from '@xterm/xterm';
import type {ContractHarness} from '../terminalAdapter.contract';
import {XtermTerminalAdapter} from '../xtermTerminalAdapter';

/** The xterm backend over a real xterm.js terminal that is not opened in a DOM: 20 columns by 5 rows and 200 lines of scrollback unless told otherwise. */
export const createXtermAdapter = ({cols = 20, rows = 5, scrollback = 200} = {}) =>
  new XtermTerminalAdapter(new Terminal({cols, rows, scrollback, allowProposedApi: false}));

/** Hosts the xterm backend in jsdom for the adapter contract. */
export const xtermContractHarness: ContractHarness = {
  create: () => createXtermAdapter(),
  target: () => { const element = document.createElement('div'); document.body.append(element); return {kind: 'dom', element}; },
};
