// A phone may have resized a Session's pty while this window was unfocused
// (Remote Access, #147). xterm's fit is a no-op when its own grid didn't
// change, but sessionCache.fit() still pushes the desktop cols/rows to the
// pty explicitly, so focusing the Mac always takes the size back with no
// manual step. Kept out of Terminal.jsx so a test without a DOM can drive the
// exact listener the component installs.
export function subscribeRefitOnFocus(target, sessionId, fit) {
  const refit = () => fit(sessionId);
  target.addEventListener('focus', refit);
  return () => target.removeEventListener('focus', refit);
}
