import net from 'node:net';
import { randomBytes } from 'node:crypto';

// A WebSocket client that never honours a close frame: it does the upgrade
// and the framing by hand over a raw TCP socket, so when the server sends
// close it neither answers nor stops sending. That is the peer a server
// must assume — `ws.close(code)` only *asks* — and the `ws` library can't
// play it, because it answers close frames itself.
//
// Shaped like the WebSocket constructor the shared client takes, so a real
// `createClient` rides on it: `send` keeps writing sealed frames after the
// server said goodbye, for as long as the TCP connection lives. Only the
// TCP connection actually ending (the server terminating it) reports close.
// `closeCodes` records every close frame the server sent.

export function stubbornWebSocket() {
  const sockets = [];
  class StubbornWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      const target = new URL(url);
      this.readyState = 0;
      this.closeCodes = [];
      this.closeListeners = [];
      this.tcpClosed = false;
      sockets.push(this);
      const key = randomBytes(16).toString('base64');
      this.tcp = net.connect(Number(target.port), target.hostname, () => {
        this.tcp.write(
          `GET ${target.pathname} HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let buffer = Buffer.alloc(0);
      let upgraded = false;
      this.tcp.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          upgraded = true;
          buffer = buffer.subarray(end + 4);
          this.readyState = 1;
          this.onopen?.();
        }
        // Server frames: unmasked and, from `ws`, never fragmented.
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          let length = buffer[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (buffer.length < 10) return;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 0x1) {
            this.onmessage?.({ data: payload.toString('utf8') });
          } else if (opcode === 0x8) {
            // Ignored on purpose: no close reply, readyState stays OPEN.
            this.closeCodes.push(payload.length >= 2 ? payload.readUInt16BE(0) : null);
          }
        }
      });
      this.tcp.on('error', () => {});
      this.tcp.on('close', () => {
        this.tcpClosed = true;
        this.readyState = 3;
        for (const cb of this.closeListeners) cb({ code: 1006 });
      });
    }

    send(text) {
      const payload = Buffer.from(String(text), 'utf8');
      const mask = randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      if (!this.tcp.destroyed) this.tcp.write(Buffer.concat([header, mask, masked]));
    }

    // The point of this client: asked to close, it carries on.
    close() {}

    addEventListener(type, cb) {
      if (type === 'close') this.closeListeners.push(cb);
    }

    destroy() {
      this.tcp.destroy();
    }
  }
  return {
    StubbornWebSocket,
    sockets,
    destroyAll: () => sockets.forEach((s) => s.destroy()),
  };
}
