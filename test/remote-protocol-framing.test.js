import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  sealChannelFrame,
  openChannelFrame,
  createChannelSession,
} from '../shared/remote-protocol/index.cjs';

// Channel frames (protocol v2), ported from Orca's
// mobile-e2ee-v2-framing.test.ts: the receiver recomputes the nonce from
// what it expects next and requires the sealed header to match, so every
// way of presenting a frame other than as exactly the next one fails.

const key = new Uint8Array(32).fill(7);
const sessionId = new Uint8Array(32).fill(8);
const payload = new TextEncoder().encode('e2ee-auth');

describe('channel framing', () => {
  it('round-trips frame 0 with the fixed nonce layout', () => {
    const frame = sealChannelFrame({
      payload,
      key,
      sessionId,
      direction: 'phone-to-mac',
      kind: 'text',
      counter: 0,
    });
    // sessionId[0..12) ‖ version 2 ‖ direction ‖ kind ‖ 0 ‖ counter (u64 BE)
    expect(Buffer.from(frame.subarray(0, 24)).toString('hex')).toBe(
      '080808080808080808080808020000000000000000000000'
    );
    expect(
      openChannelFrame({
        frame,
        key,
        sessionId,
        direction: 'phone-to-mac',
        kind: 'text',
        expectedCounter: 0,
      })
    ).toEqual(payload);
  });

  it('rejects replay, gap, reflection, kind confusion and cross-session frames', () => {
    const frame = sealChannelFrame({
      payload,
      key,
      sessionId,
      direction: 'phone-to-mac',
      kind: 'binary',
      counter: 4,
    });
    const attempt = (overrides) =>
      openChannelFrame({
        frame,
        key,
        sessionId,
        direction: 'phone-to-mac',
        kind: 'binary',
        expectedCounter: 4,
        ...overrides,
      });

    expect(attempt({})).toEqual(payload);
    expect(attempt({ expectedCounter: 3 })).toBeNull(); // replay of an older slot
    expect(attempt({ expectedCounter: 5 })).toBeNull(); // gap: 4 already used
    expect(attempt({ direction: 'mac-to-phone' })).toBeNull(); // reflection
    expect(attempt({ kind: 'text' })).toBeNull(); // kind confusion
    expect(attempt({ sessionId: new Uint8Array(32).fill(9) })).toBeNull(); // cross-session
    expect(attempt({ key: new Uint8Array(32).fill(1) })).toBeNull(); // other key
  });

  it('requires the sealed header to match exactly, not just the nonce', () => {
    // A frame whose nonce says counter 4 but whose authenticated header says
    // 5 — what a peer with the key but a confused (or hostile) encoder would
    // send. The box opens; the header check refuses it.
    const nonce = sealChannelFrame({
      payload,
      key,
      sessionId,
      direction: 'phone-to-mac',
      kind: 'text',
      counter: 4,
    }).subarray(0, 24);
    const header = new Uint8Array(42);
    header.set(sessionId, 0);
    header[32] = 0;
    header[33] = 0;
    header[41] = 5;
    const plaintext = new Uint8Array([...header, ...payload]);
    const forged = new Uint8Array([...nonce, ...nacl.secretbox(plaintext, nonce, key)]);
    expect(
      openChannelFrame({
        frame: forged,
        key,
        sessionId,
        direction: 'phone-to-mac',
        kind: 'text',
        expectedCounter: 4,
      })
    ).toBeNull();
  });

  it('round-trips successive frames of both kinds', () => {
    const kinds = ['text', 'binary', 'text'];
    const frames = kinds.map((kind, counter) =>
      sealChannelFrame({
        payload: new Uint8Array([counter]),
        key,
        sessionId,
        direction: 'mac-to-phone',
        kind,
        counter,
      })
    );
    frames.forEach((frame, counter) => {
      expect(
        openChannelFrame({
          frame,
          key,
          sessionId,
          direction: 'mac-to-phone',
          kind: kinds[counter],
          expectedCounter: counter,
        })
      ).toEqual(new Uint8Array([counter]));
    });
  });

  it('refuses a truncated frame without throwing', () => {
    expect(
      openChannelFrame({
        frame: new Uint8Array(30),
        key,
        sessionId,
        direction: 'phone-to-mac',
        kind: 'text',
        expectedCounter: 0,
      })
    ).toBeNull();
  });
});

describe('channel session', () => {
  const keys = {
    phoneToMacKey: new Uint8Array(32).fill(1),
    macToPhoneKey: new Uint8Array(32).fill(2),
    sessionId,
  };

  it('carries JSON both ways in order', () => {
    const phone = createChannelSession({ keys, role: 'phone' });
    const mac = createChannelSession({ keys, role: 'mac' });
    expect(mac.open(phone.seal({ n: 0 }))).toEqual({ n: 0 });
    expect(mac.open(phone.seal({ n: 1 }))).toEqual({ n: 1 });
    expect(phone.open(mac.seal({ ok: true }))).toEqual({ ok: true });
  });

  it('refuses a replayed, reordered or reflected frame', () => {
    const phone = createChannelSession({ keys, role: 'phone' });
    const mac = createChannelSession({ keys, role: 'mac' });
    const first = phone.seal({ n: 0 });
    const second = phone.seal({ n: 1 });
    expect(mac.open(second)).toBeNull(); // reordered
    expect(mac.open(first)).toEqual({ n: 0 });
    expect(mac.open(first)).toBeNull(); // replayed
    // Reflected: the phone's own frame handed back to it.
    const own = createChannelSession({ keys, role: 'phone' });
    expect(own.open(createChannelSession({ keys, role: 'phone' }).seal({}))).toBeNull();
    expect(mac.open('not base64!')).toBeNull();
  });
});
