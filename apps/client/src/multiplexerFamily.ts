import type {MultiplexerKind} from './bridge';
/** tmux and rmux share one command stack: attach, tree, actions and `-L` server labels. */
export const isTmuxFamily = (kind: MultiplexerKind | undefined): kind is 'tmux' | 'rmux' => kind === 'tmux' || kind === 'rmux';
