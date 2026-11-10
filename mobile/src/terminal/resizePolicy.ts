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

// When a frame change may refit at all, ported from Orca's
// terminal-viewport-refit-state.ts. While the soft keyboard is visible, a
// frame change (the keyboard taking height) is held, not sent — reflowing
// the pty under every keystroke garbles a TUI — and flushed once the
// keyboard closes. A deferred refit that lands with the keyboard back open
// is held again. Keyboard visibility comes from keyboardWillShow/WillHide on
// iOS (they fire before the frame moves) and the Did events on Android
// (there are no Will events), after Orca's keyboard-occlusion.ts.

export interface FrameRefitState {
  frameWidth: number;
  frameHeight: number;
  keyboardVisible: boolean;
  pending: boolean;
}

export type FrameRefitEvent =
  | { type: 'frame'; width: number; height: number }
  | { type: 'keyboard-visibility'; visible: boolean }
  // A refit was asked for outside a frame change (reconnect, text size,
  // returning to the app) and the resize policy deferred it.
  | { type: 'refit-deferred' };

export const INITIAL_FRAME_REFIT: FrameRefitState = {
  frameWidth: 0,
  frameHeight: 0,
  keyboardVisible: false,
  pending: false,
};

export function reduceFrameRefit(
  state: FrameRefitState,
  event: FrameRefitEvent
): { state: FrameRefitState; shouldRefit: boolean } {
  if (event.type === 'refit-deferred') {
    return { state: { ...state, pending: true }, shouldRefit: false };
  }
  if (event.type === 'keyboard-visibility') {
    if (event.visible === state.keyboardVisible) return { state, shouldRefit: false };
    if (event.visible) return { state: { ...state, keyboardVisible: true }, shouldRefit: false };
    return { state: { ...state, keyboardVisible: false, pending: false }, shouldRefit: state.pending };
  }
  if (event.width === state.frameWidth && event.height === state.frameHeight) {
    return { state, shouldRefit: false };
  }
  const frame = { frameWidth: event.width, frameHeight: event.height };
  if (state.keyboardVisible) return { state: { ...state, ...frame, pending: true }, shouldRefit: false };
  return { state: { ...state, ...frame, pending: false }, shouldRefit: true };
}

// The reconnect / text-size flags must survive a refit that didn't go out:
// cleared only once a resize is actually sent.
export function clearsRefitFlags(decision: ResizeDecision): boolean {
  return decision === 'send';
}

export function keyboardEvents(os: string): { show: 'keyboardWillShow' | 'keyboardDidShow'; hide: 'keyboardWillHide' | 'keyboardDidHide' } {
  return os === 'ios'
    ? { show: 'keyboardWillShow', hide: 'keyboardWillHide' }
    : { show: 'keyboardDidShow', hide: 'keyboardDidHide' };
}
