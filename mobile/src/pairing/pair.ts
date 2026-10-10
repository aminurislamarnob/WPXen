// Pairing this phone with a Mac: scan (or paste) the offer, show the
// 4-digit code while the Mac asks Allow/Deny, then persist the host. Every
// failure maps to its own message — the Mac's rejection reasons travel in
// plaintext, so no guessing.

import {
  PROTOCOL_VERSION,
  PAIR_ERRORS,
  newKeyPair,
  encodeBase64,
  decodeBase64,
  parsePairingUrl,
  createPairRequest,
  openPairAccept,
} from '../protocol';
import type { HostRecord } from '../hosts/hostList';

export type PairFailureReason =
  | 'invalid-link'
  | 'unreachable'
  | 'expired'
  | 'used'
  | 'denied'
  | 'timeout'
  | 'version-desktop'
  | 'version-phone'
  | 'rate-limited'
  | 'invalid-secret';

export type PairResult =
  | { ok: true; host: HostRecord; keys: { publicKey: string; secretKey: string }; code: string }
  | { ok: false; reason: PairFailureReason };

const CONNECT_TIMEOUT_MS = 15_000;
// The Mac's Allow/Deny dialog waits 2 minutes; give the reply a margin past it.
const REPLY_TIMEOUT_MS = 150_000;

function reasonForRejection(reason: string): PairFailureReason {
  switch (reason) {
    case PAIR_ERRORS.pairingExpired:
      return 'expired';
    case PAIR_ERRORS.pairingUsed:
      return 'used';
    case PAIR_ERRORS.pairingDenied:
      return 'denied';
    case PAIR_ERRORS.pairingTimeout:
      return 'timeout';
    case PAIR_ERRORS.rateLimited:
      return 'rate-limited';
    case PAIR_ERRORS.invalidSecret:
      return 'invalid-secret';
    default:
      return 'invalid-secret';
  }
}

export interface PairArgs {
  link: string;
  deviceName: string;
  platform: string;
  socketCtor?: typeof WebSocket;
  // Called with the 4-digit code before the request goes out, so the UI can
  // show it while the Mac waits for Allow.
  onCode?: (code: string) => void;
}

export async function pairWithLink({
  link,
  deviceName,
  platform,
  socketCtor = WebSocket,
  onCode,
}: PairArgs): Promise<PairResult> {
  let offer;
  try {
    offer = parsePairingUrl(link.trim());
  } catch {
    return { ok: false, reason: 'invalid-link' };
  }
  if (offer.version !== PROTOCOL_VERSION) {
    return { ok: false, reason: offer.version > PROTOCOL_VERSION ? 'version-desktop' : 'version-phone' };
  }

  const keys = newKeyPair();
  const hostPublicKey = decodeBase64(offer.hostPublicKeyB64);
  const { message, code } = createPairRequest({
    secret: offer.secret,
    deviceName,
    platform,
    keys,
    hostPublicKey,
    version: PROTOCOL_VERSION,
  });

  let socket: WebSocket;
  try {
    onCode?.(code);
    socket = new socketCtor(offer.wssUrl);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('connect failed'));
      };
    });
  } catch {
    try {
      socket.close();
    } catch {
      // Ignore.
    }
    return { ok: false, reason: 'unreachable' };
  }

  let reply: { type?: string; reason?: string; update?: string; deviceId?: string; code?: string; nonce?: string; box?: string };
  try {
    reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reply timeout')), REPLY_TIMEOUT_MS);
      socket.onmessage = (event) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          reject(new Error('bad reply'));
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('socket failed'));
      };
      socket.send(JSON.stringify(message));
    });
  } catch {
    try {
      socket.close();
    } catch {
      // Ignore.
    }
    return { ok: false, reason: 'timeout' };
  }

  if (reply.type === 'pair-reject') {
    if (reply.reason === PAIR_ERRORS.versionMismatch) {
      try {
        socket.close();
      } catch {
        // Ignore.
      }
      return { ok: false, reason: reply.update === 'desktop' ? 'version-desktop' : 'version-phone' };
    }
    try {
      socket.close();
    } catch {
      // Ignore.
    }
    return { ok: false, reason: reasonForRejection(reply.reason ?? '') };
  }

  if (reply.type !== 'pair-accept' || !reply.deviceId || !reply.nonce || !reply.box) {
    try {
      socket.close();
    } catch {
      // Ignore.
    }
    return { ok: false, reason: 'invalid-secret' };
  }

  let deviceId: string;
  try {
    ({ deviceId } = openPairAccept({ message: reply, keys, hostPublicKey }));
  } catch {
    try {
      socket.close();
    } catch {
      // Ignore.
    }
    return { ok: false, reason: 'invalid-secret' };
  }
  try {
    socket.close();
  } catch {
    // Ignore.
  }

  const keysB64 = { publicKey: encodeBase64(keys.publicKey), secretKey: encodeBase64(keys.secretKey) };
  return {
    ok: true,
    code,
    keys: keysB64,
    host: {
      id: deviceId,
      name: deviceName,
      url: offer.wssUrl,
      hostId: offer.hostId,
      hostPublicKey: offer.hostPublicKeyB64,
      lastSeen: Date.now(),
    },
  };
}

export function pairFailureMessage(reason: PairFailureReason): string {
  switch (reason) {
    case 'invalid-link':
      return 'That is not a pairing link. Scan the QR again or paste the full link.';
    case 'unreachable':
      return 'Could not reach the Mac. Check the tunnel is connected and try again.';
    case 'expired':
      return 'That code expired. Ask the Mac for a new one.';
    case 'used':
      return 'That code was already used. Ask the Mac for a new one.';
    case 'denied':
      return 'The Mac denied the pairing.';
    case 'timeout':
      return 'Nobody answered on the Mac in time. Try again.';
    case 'version-desktop':
      return 'Update WPXen on the Mac, then pair again.';
    case 'version-phone':
      return 'Update this app, then pair again.';
    case 'rate-limited':
      return 'Too many attempts. Wait a few minutes and ask the Mac for a new code.';
    case 'invalid-secret':
      return 'Pairing failed. Ask the Mac for a new code and try again.';
  }
}

