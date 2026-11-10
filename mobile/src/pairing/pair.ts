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
import { secureRandomBytes } from '../crypto';

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
  | 'invalid-secret'
  // The user cancelled, or left the screen, before the Mac answered.
  | 'cancelled';

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
  // Cancel and leaving the screen abort: the socket closes, which the Mac
  // reads as the phone hanging up (it closes its Allow/Deny dialog and
  // stores nothing), and a late Allow can no longer pair this phone (after
  // Orca e0b5a428527).
  signal?: AbortSignal;
}

const CANCELLED: PairResult = { ok: false, reason: 'cancelled' };

export async function pairWithLink({
  link,
  deviceName,
  platform,
  socketCtor = WebSocket,
  onCode,
  signal,
}: PairArgs): Promise<PairResult> {
  if (signal?.aborted) return CANCELLED;
  let offer;
  try {
    offer = parsePairingUrl(link.trim());
  } catch {
    return { ok: false, reason: 'invalid-link' };
  }
  if (offer.version !== PROTOCOL_VERSION) {
    return { ok: false, reason: offer.version > PROTOCOL_VERSION ? 'version-desktop' : 'version-phone' };
  }

  const keys = newKeyPair(secureRandomBytes);
  const hostPublicKey = decodeBase64(offer.hostPublicKeyB64);
  const { message, code } = createPairRequest({
    secret: offer.secret,
    deviceName,
    platform,
    keys,
    hostPublicKey,
    version: PROTOCOL_VERSION,
    randomBytes: secureRandomBytes,
  });

  let socket: WebSocket;
  try {
    onCode?.(code);
    socket = new socketCtor(offer.wssUrl);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  // Rejects whichever wait is pending when the signal fires, and hangs up.
  let abortWait: (() => void) | null = null;
  const onAbort = () => {
    abortWait?.();
    try {
      socket.close();
    } catch {
      // Ignore.
    }
  };
  signal?.addEventListener('abort', onAbort);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
      abortWait = () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      };
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
    signal?.removeEventListener('abort', onAbort);
    return signal?.aborted ? CANCELLED : { ok: false, reason: 'unreachable' };
  }

  let reply: { type?: string; reason?: string; update?: string; deviceId?: string; code?: string; nonce?: string; box?: string };
  try {
    reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reply timeout')), REPLY_TIMEOUT_MS);
      abortWait = () => {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      };
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
    signal?.removeEventListener('abort', onAbort);
    return signal?.aborted ? CANCELLED : { ok: false, reason: 'timeout' };
  }
  // The reply is in: from here on nothing waits, and a cancel that already
  // landed wins over whatever the Mac said.
  abortWait = null;
  signal?.removeEventListener('abort', onAbort);
  if (signal?.aborted) {
    try {
      socket.close();
    } catch {
      // Ignore.
    }
    return CANCELLED;
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
  let machineName: string | null;
  try {
    ({ deviceId, machineName } = openPairAccept({ message: reply, keys, hostPublicKey }));
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
      // The Mac's name — not this phone's own, which every Mac used to be
      // filed under.
      name: machineName || 'Mac',
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
    case 'cancelled':
      return 'Pairing cancelled.';
  }
}

