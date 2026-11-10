import { describe, expect, it, vi } from 'vitest';
import { encodeBase64, newKeyPair, PROTOCOL_VERSION } from '../protocol';
import { pairWithLink } from './pair';
import { pairingUrl } from '../../../shared/remote-protocol/index.cjs';

// expo-crypto is native; pairing only needs bytes from it (vi.mock is
// hoisted above the imports).
vi.mock('../crypto', async () => {
  const { randomBytes } = await import('node:crypto');
  return { secureRandomBytes: (n: number) => new Uint8Array(randomBytes(n)) };
});

// A socket that opens at once and never hears back from the Mac — the phone
// waiting on Allow/Deny.
class SilentMacSocket {
  static last: SilentMacSocket | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    SilentMacSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function offerLink() {
  const host = newKeyPair();
  return pairingUrl({
    version: PROTOCOL_VERSION,
    hostId: 'host-1',
    hostPublicKeyB64: encodeBase64(host.publicKey),
    secret: 'a'.repeat(43),
    wssUrl: 'wss://mac.example.test/wpxen-device',
  });
}

describe('pairWithLink cancel', () => {
  it('cancelling while the Mac decides hangs up and resolves cancelled', async () => {
    const controller = new AbortController();
    let code = '';
    const pending = pairWithLink({
      link: offerLink(),
      deviceName: 'Phone',
      platform: 'ios',
      socketCtor: SilentMacSocket as unknown as typeof WebSocket,
      signal: controller.signal,
      onCode: (c) => {
        code = c;
      },
    });
    await vi.waitFor(() => expect(SilentMacSocket.last?.sent.length).toBe(1));
    expect(code).toMatch(/^\d{4}$/);

    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(SilentMacSocket.last?.closed).toBe(true);
  });

  it('cancelling before the socket opens resolves cancelled, not unreachable', async () => {
    const controller = new AbortController();
    const pending = pairWithLink({
      link: offerLink(),
      deviceName: 'Phone',
      platform: 'ios',
      socketCtor: SilentMacSocket as unknown as typeof WebSocket,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });

  it('an already-aborted signal never dials', async () => {
    const controller = new AbortController();
    controller.abort();
    SilentMacSocket.last = null;
    const result = await pairWithLink({
      link: offerLink(),
      deviceName: 'Phone',
      platform: 'ios',
      socketCtor: SilentMacSocket as unknown as typeof WebSocket,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, reason: 'cancelled' });
    expect(SilentMacSocket.last).toBeNull();
  });
});
