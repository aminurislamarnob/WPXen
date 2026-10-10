// Who owns the pty size: the device actively viewing the terminal. This
// pure decision keeps every caller honest about when a resize may go out
// (after Orca terminal-viewport-refit: covered PTYs, keyboard-transition
// debounce, reconnect re-assertion, rotation/fold, text-size debounce).

export type ResizeDecision = 'send' | 'skip' | 'defer';

export interface ResizeDims {
  cols: number;
  rows: number;
}

export interface ResizeInput {
  // The terminal is the visible view.
  visible: boolean;
  // Another view (chat, modal) covers it — a refit would push phone dims
  // into a pty nobody on this device is viewing.
  covered: boolean;
  appState: 'active' | 'background' | 'inactive' | string;
  // The soft keyboard is opening or closing: height-only changes until it
  // settles, or the pty reflows mid-keystroke (and a reopen inside the
  // debounce must re-check rather than fire blindly).
  keyboardTransitioning: boolean;
  dims: ResizeDims;
  lastSentDims: ResizeDims | null;
  // Fresh reconnect: re-assert even unchanged dims, because the desktop may
  // have resized the pty while the socket was down.
  reconnected: boolean;
  // Font applied anew: cell metrics changed, so re-fit after it lands.
  textSizeChanged: boolean;
}

function sameDims(a: ResizeDims, b: ResizeDims | null): boolean {
  return b !== null && a.cols === b.cols && a.rows === b.rows;
}

export function decideResize(input: ResizeInput): ResizeDecision {
  if (!input.visible || input.covered || input.appState !== 'active') return 'skip';
  if (input.keyboardTransitioning) return 'defer';
  if (input.reconnected || input.textSizeChanged) return 'send';
  if (sameDims(input.dims, input.lastSentDims)) return 'skip';
  return 'send';
}
