import { describe, it, expect, beforeEach } from 'vitest';
import browser from '../electron/services/browser.cjs';

// Favicons can live on any host, but the renderer's CSP only allows images
// from named hosts (Tasks renders markdown written by anyone). So the main
// process fetches them and hands back data: URLs. That makes this the place
// arbitrary URLs get fetched, so it has to stay bounded: http(s) only, image
// responses only, a size cap — and it shouldn't refetch what it already has.

let calls;
let respond;

beforeEach(() => {
  calls = [];
  browser.__setDeps({
    fetchInPartition: async (url) => {
      calls.push(url);
      return respond(url);
    },
  });
});

const png = Buffer.from('89504e470d0a1a0a', 'hex'); // a PNG signature is plenty
const image = (body = png, headers = {}) =>
  new Response(body, { headers: { 'content-type': 'image/png', ...headers } });

// Each test uses its own URL: the cache is module-level by design.
let n = 0;
const url = () => `https://site${++n}.test/favicon.ico`;

describe('fetchFavicon', () => {
  it('returns an image as a data: URL', async () => {
    respond = () => image();
    expect(await browser.fetchFavicon(url())).toBe(
      `data:image/png;base64,${png.toString('base64')}`
    );
  });

  it('only fetches http(s) URLs', async () => {
    respond = () => image();
    for (const u of [
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:image/png;base64,AA',
    ]) {
      expect(await browser.fetchFavicon(u)).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('refuses a response that is not an image', async () => {
    respond = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
    expect(await browser.fetchFavicon(url())).toBeNull();
  });

  it('refuses an image over the size cap, declared or not', async () => {
    respond = () => image(png, { 'content-length': String(10 * 1024 * 1024) });
    expect(await browser.fetchFavicon(url())).toBeNull();
    respond = () => image(Buffer.alloc(300 * 1024));
    expect(await browser.fetchFavicon(url())).toBeNull();
  });

  it('refuses an error response', async () => {
    respond = () =>
      new Response(png, { status: 404, headers: { 'content-type': 'image/png' } });
    expect(await browser.fetchFavicon(url())).toBeNull();
  });

  it('fetches a URL once, whether it was found or not', async () => {
    const found = url();
    const missing = url();
    respond = (u) => (u === found ? image() : new Response('', { status: 404 }));
    await browser.fetchFavicon(found);
    await browser.fetchFavicon(found);
    await browser.fetchFavicon(missing);
    await browser.fetchFavicon(missing);
    expect(calls).toEqual([found, missing]);
  });

  it('retries after a network failure instead of remembering it', async () => {
    const u = url();
    respond = () => {
      throw new Error('offline');
    };
    expect(await browser.fetchFavicon(u)).toBeNull();
    respond = () => image();
    expect(await browser.fetchFavicon(u)).toMatch(/^data:image\/png;base64,/);
    expect(calls).toEqual([u, u]);
  });
});
