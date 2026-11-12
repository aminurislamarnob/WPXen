import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import repairServer from '../electron/services/repairServer.cjs';

// The repair endpoint, on a real Unix socket in a temp folder: two routes,
// one method each, a known host only, and no TCP listener at all.

let dir;
let socketPath;
let server;
let calls;

const fakeRepairer = {
  status: (host) =>
    host === 'shop.test'
      ? { state: 'idle', step: null, phpVersion: '8.4', error: null }
      : null,
  repair: async (host) => {
    calls.push(host);
    return host === 'shop.test' ? { state: 'healthy' } : null;
  },
};

function request(method, urlPath, host = 'shop.test') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path: urlPath, headers: host ? { Host: host } : {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            json = null; // not JSON; the status code is what's asserted
          }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxr-'));
  socketPath = path.join(dir, 'run', 'wpxen-repair.sock');
  calls = [];
  server = await repairServer.listen({ socketPath, repairer: fakeRepairer });
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('routes', () => {
  it('POST repair starts a repair for the host and answers with its status', async () => {
    const res = await request('POST', '/__wpxen/repair');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ phpVersion: '8.4' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual(['shop.test']);
  });

  it('GET status answers without repairing', async () => {
    const res = await request('GET', '/__wpxen/status');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      state: 'idle',
      step: null,
      phpVersion: '8.4',
      error: null,
    });
    expect(calls).toEqual([]);
  });

  it('takes nothing from the caller but the host', async () => {
    await request('POST', '/__wpxen/repair?version=7.4&cmd=rm');
    expect(calls).toEqual(['shop.test']);
  });
});

describe('rejections', () => {
  it('rejects an unknown host', async () => {
    expect((await request('POST', '/__wpxen/repair', 'evil.test')).status).toBe(403);
    expect((await request('GET', '/__wpxen/status', 'evil.test')).status).toBe(403);
    expect((await request('GET', '/__wpxen/status', null)).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects an unknown route', async () => {
    for (const p of ['/', '/__wpxen/restart', '/__wpxen/repair/x', '/__wpxen/502.html']) {
      expect((await request('POST', p)).status, p).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('rejects a wrong method, naming the right one', async () => {
    const getRepair = await request('GET', '/__wpxen/repair');
    expect(getRepair.status).toBe(405);
    expect(getRepair.headers.allow).toBe('POST');
    const postStatus = await request('POST', '/__wpxen/status');
    expect(postStatus.status).toBe(405);
    expect(postStatus.headers.allow).toBe('GET');
    expect((await request('DELETE', '/__wpxen/repair')).status).toBe(405);
    expect(calls).toEqual([]);
  });
});

describe('the socket', () => {
  it('listens on the Unix socket only, never a TCP port', () => {
    expect(server.address()).toBe(socketPath);
    expect(typeof server.address()).toBe('string');
  });

  it('is readable and writable by this user only', () => {
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it('replaces a stale socket file left by a crash, and removes its own on close', async () => {
    await server.close();
    fs.writeFileSync(socketPath, 'stale');
    server = await repairServer.listen({ socketPath, repairer: fakeRepairer });
    expect((await request('GET', '/__wpxen/status')).status).toBe(200);
    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
    server = await repairServer.listen({ socketPath, repairer: fakeRepairer });
  });
});
