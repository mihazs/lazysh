import {Terminal} from '@xterm/xterm';
import type {ContractHarness} from '../terminalAdapter.contract';
import {XtermTerminalAdapter} from '../xtermTerminalAdapter';

/** Hosts the xterm backend in jsdom for the adapter contract: 20 columns by 5 rows and 200 lines of scrollback. */
export const xtermContractHarness: ContractHarness = {
  create: () => new XtermTerminalAdapter(new Terminal({cols: 20, rows: 5, scrollback: 200, allowProposedApi: false})),
  target: () => { const element = document.createElement('div'); document.body.append(element); return {kind: 'dom', element}; },
};
