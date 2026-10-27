import {
  PROTOCOL_VERSION,
  acceptHello,
  isAuthPayload,
} from '../../shared/remote-protocol/index.cjs';

// The Mac's end of one device connection, built from the shared handshake
// (handshake.cjs) rather than re-implemented, for tests that stand in for
// the Mac without the whole Remote Access service. Feed it each raw message
// the phone sent; it answers the hello with a ready, the auth frame with the
// connected event, and hands every later payload back to the caller.
// `opened` counts the sealed frames it accepted (auth is frame 0).

export function createMacEnd({ hostKeys, devicePublicKey, deviceId }) {
  let session = null;
  let authed = false;
  const opened = [];
  return {
    opened,
    receive(raw) {
      let outer;
      try {
        outer = JSON.parse(String(raw));
      } catch {
        return { close: true };
      }
      if (!session) {
        const accepted = acceptHello({ hello: outer, hostKeys, devicePublicKey });
        if (!accepted) return { close: true };
        session = accepted.session;
        return { reply: accepted.reply };
      }
      const payload = session.open(outer.frame);
      if (!payload) return { close: true };
      opened.push(opened.length);
      if (!authed) {
        if (!isAuthPayload(payload, deviceId)) return { close: true };
        authed = true;
        return {
          reply: this.seal({ kind: 'event', name: 'connected', payload: { deviceId } }),
        };
      }
      return { payload };
    },
    seal(payload) {
      return { v: PROTOCOL_VERSION, frame: session.seal(payload) };
    },
  };
}
