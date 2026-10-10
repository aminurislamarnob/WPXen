// One host's connection lifecycle: connect on open and on foreground,
// heartbeat while up, exponential backoff with jitter after a drop, and no
// more retries once the Mac reports this device revoked. The states come
// from state.ts so every screen agrees; the backoff schedule from
// backoff.ts. The encrypted channel itself is the shared client half.

import { AppState, type AppStateStatus } from 'react-native';
import { backoffDelayMs } from './backoff';
import { deriveConnectionState, type ConnectionState } from './state';
import { createClient, decodeBase64 } from '../protocol';
import type { HostRecord } from '../hosts/hostList';

export interface ConnectionUpdate {
  state: ConnectionState;
  // Last ping round-trip while connected, for the host screen's proof.
  rttMs: number | null;
  lastSeenAt: number | null;
}

interface ManagerArgs {
  host: HostRecord;
  deviceId: string;
  keys: { publicKey: string; secretKey: string };
  socketCtor?: typeof WebSocket;
  now?: () => number;
  random?: () => number;
  heartbeatMs?: number;
  missedToLose?: number;
  onUpdate: (update: ConnectionUpdate) => void;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MISSED_TO_LOSE = 2;

export class HostConnection {
  private args: ManagerArgs;
  private stopped = true;
  private attempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private client: ReturnType<typeof createClient> | null = null;
  private lastSeenAt: number | null = null;
  private rttMs: number | null = null;
  private missed = 0;
  private heartbeatLost = false;
  private socket: 'open' | 'connecting' | 'closed' = 'closed';
  private closeStatus: 'revoked' | 'closed' | null = null;
  private appStateSub: { remove: () => void } | null = null;

  constructor(args: ManagerArgs) {
    this.args = {
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      missedToLose: DEFAULT_MISSED_TO_LOSE,
      ...args,
    };
    this.lastSeenAt = args.host.lastSeen;
  }

  private emit(): void {
    this.args.onUpdate({
      state: deriveConnectionState({
        socket: this.socket,
        closeStatus: this.closeStatus,
        lastSeenAt: this.lastSeenAt,
        heartbeatLost: this.heartbeatLost,
      }),
      rttMs: this.rttMs,
      lastSeenAt: this.lastSeenAt,
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop();
    // A return to the foreground re-opens a socket the OS killed silently.
    this.appStateSub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active' && !this.stopped && this.socket !== 'open') {
        this.loop();
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.appStateSub?.remove();
    this.appStateSub = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHeartbeat();
    try {
      this.client?.close();
    } catch {
      // Ignore.
    }
    this.client = null;
    this.socket = 'closed';
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async loop(): Promise<void> {
    if (this.stopped || this.socket === 'open' || this.socket === 'connecting') return;
    // Revocation is terminal: the list screen owns the row from here.
    if (this.closeStatus === 'revoked') return;
    this.socket = 'connecting';
    this.emit();
    try {
      await this.connectOnce();
    } catch {
      // connectOnce reports through onUpdate already.
    }
    // Snapshot through a cast: narrowing follows the initializer otherwise.
    const socketAfter = this.socket as 'open' | 'connecting' | 'closed';
    const closeAfter = this.closeStatus as 'revoked' | 'closed' | null;
    if (this.stopped || closeAfter === 'revoked') return;
    if (socketAfter === 'open') return;
    this.attempts += 1;
    this.emit();
    const delay = backoffDelayMs(this.attempts, this.args.random ?? Math.random);
    await new Promise<void>((resolve) => {
      this.retryTimer = setTimeout(resolve, delay);
    });
    this.retryTimer = null;
    this.loop();
  }

  private async connectOnce(): Promise<void> {
    const { host, deviceId, keys, socketCtor = WebSocket, now = Date.now } = this.args;
    const client = createClient({
      url: host.url,
      WebSocket: socketCtor,
      keys: { publicKey: decodeBase64(keys.publicKey), secretKey: decodeBase64(keys.secretKey) },
      hostPublicKey: decodeBase64(host.hostPublicKey),
      deviceId,
    });
    this.client = client;
    client.onClose((status: 'revoked' | 'closed') => {
      this.socket = 'closed';
      this.closeStatus = status;
      this.stopHeartbeat();
      this.emit();
      if (!this.stopped) this.loop();
    });
    try {
      await client.connect();
    } catch {
      this.socket = 'closed';
      this.closeStatus = 'closed';
      this.emit();
      return;
    }
    this.socket = 'open';
    this.closeStatus = null;
    this.heartbeatLost = false;
    this.missed = 0;
    this.attempts = 0;
    this.lastSeenAt = now();
    this.emit();
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const { heartbeatMs = DEFAULT_HEARTBEAT_MS, missedToLose = DEFAULT_MISSED_TO_LOSE, now = Date.now } = this.args;
    this.heartbeatTimer = setInterval(async () => {
      if (this.stopped || this.socket !== 'open' || !this.client) return;
      const started = now();
      try {
        await this.client.request('ping', { timeoutMs: heartbeatMs });
        this.rttMs = now() - started;
        this.missed = 0;
        this.heartbeatLost = false;
        this.lastSeenAt = now();
      } catch {
        this.missed += 1;
        if (this.missed >= missedToLose) {
          // Pings die unanswered although the socket looks open: asleep,
          // not merely offline — and the dead socket goes so the loop
          // redials instead of nursing it.
          this.heartbeatLost = true;
          this.emit();
          try {
            this.client?.close();
          } catch {
            // The close handler restarts the loop.
          }
          return;
        }
      }
      this.emit();
    }, heartbeatMs);
  }
}
