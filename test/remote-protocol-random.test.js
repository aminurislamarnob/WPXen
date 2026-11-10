import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import remoteAccess, { HOST_ID_KEY } from '../electron/services/remoteAccess.cjs';
import {
  PROTOCOL_VERSION,
  newKeyPair,
  keyPairFromSecret,
  randomNonce,
  createPairRequest,
  createClient,
  encodeBase64,
  parsePairingUrl,
} from '../shared/remote-protocol/index.cjs';

// The shared protocol takes its randomness from its caller (after Orca's
// paired-e2ee-primitives.ts): the phone's expo-crypto, the Mac's Node
// crypto. Each source below is a counter so a test can tell exactly which
// bytes a key or nonce came from — a path that quietly fell back to
// tweetnacl's global PRNG (the one React Native lacks) shows up as bytes the
// source never produced.

function countingSource() {
  let next = 1;
  const draws = [];
  const randomBytes = (length) => {
    const out = new Uint8Array(length).fill(next++ & 0xff);
    draws.push(out);
    return out;
  };
  return { randomBytes, draws };
}

describe('caller-supplied randomness', () => {
  it('builds keypairs from the injected source', () => {
    const { randomBytes } = countingSource();
    const pair = newKeyPair(randomBytes);
    expect(pair).toEqual(keyPairFromSecret(new Uint8Array(32).fill(1)));
  });

  it('draws box nonces from it, and refuses a short answer', () => {
    const { randomBytes } = countingSource();
    expect(randomNonce(randomBytes)).toEqual(new Uint8Array(24).fill(1));
    expect(() => randomNonce(() => new Uint8Array(8))).toThrow(/24 bytes/);
  });

  it('seals the pair request with a nonce from it', () => {
    const { randomBytes } = countingSource();
    const { message } = createPairRequest({
      secret: 's',
      deviceName: 'Phone',
      platform: 'ios',
      keys: newKeyPair(),
      hostPublicKey: newKeyPair().publicKey,
      version: PROTOCOL_VERSION,
      randomBytes,
    });
    expect(message.nonce).toBe(encodeBase64(new Uint8Array(24).fill(1)));
  });

  it('opens a channel with nonces from it', async () => {
    const { randomBytes, draws } = countingSource();
    const sent = [];
    class Captures {
      static OPEN = 1;
      constructor() {
        this.readyState = 1;
        queueMicrotask(() => this.onopen?.());
      }
      send(raw) {
        sent.push(raw);
      }
      close() {}
    }
    const client = createClient({
      url: 'ws://127.0.0.1:1',
      WebSocket: Captures,
      keys: newKeyPair(),
      hostPublicKey: newKeyPair().publicKey,
      deviceId: 'd',
      requestTimeoutMs: 30,
      randomBytes,
    });
    const dial = client.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.length).toBeGreaterThan(0);
    expect(draws.length).toBeGreaterThan(0);
    await dial;
  });
});

describe('the Mac draws through deps.randomBytes', () => {
  const store = {
    data: { [HOST_ID_KEY]: 'test-host-id' },
    get(key, fallback) {
      return key in this.data ? this.data[key] : fallback;
    },
    set(key, value) {
      this.data[key] = value;
    },
    delete(key) {
      delete this.data[key];
    },
  };

  beforeEach(async () => {
    remoteAccess.__setDeps({
      store,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (cipher) =>
          Buffer.from(cipher.toString('utf8').replace(/^enc:/, ''), 'utf8'),
      },
      randomBytes: countingSource().randomBytes,
    });
    remoteAccess.start({ port: 0 });
    const start = Date.now();
    while (remoteAccess.getStatus().state !== 'listening') {
      if (Date.now() - start > 5000) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  afterEach(() => {
    remoteAccess.dispose();
  });

  it('for the host keypair and the pairing secret', async () => {
    const offer = await remoteAccess.pairingOffer({ hostname: 'wpxen.example.com' });
    const parsed = parsePairingUrl(offer.url);
    // First draw: the host secret key; second: the one-time pairing secret.
    expect(parsed.hostPublicKeyB64).toBe(
      encodeBase64(keyPairFromSecret(new Uint8Array(32).fill(1)).publicKey)
    );
    expect(parsed.secret).toBe('02'.repeat(16));
  });
});
