import { describe, expect, it } from 'vitest';
import { registerWith, registrationNote, type PushPlatform } from './registration';

// Push used to degrade to a silent "skipped" on every failure — no EAS
// project id (always, before app.config.js), Expo Go, a simulator, a thrown
// token request — so a phone that would never get a push looked fine.

function platform(over: Partial<PushPlatform> = {}): PushPlatform {
  return {
    executionEnvironment: 'standalone',
    isDevice: true,
    projectId: 'project-1',
    getPermissions: async () => ({ status: 'granted' }),
    requestPermissions: async () => ({ status: 'granted' }),
    getToken: async () => ({ data: 'ExponentPushToken[abc]' }),
    ...over,
  };
}

describe('push registration', () => {
  it('registers the token with the Mac', async () => {
    const sent: unknown[] = [];
    const result = await registerWith(platform(), async (op, params) => {
      sent.push([op, params]);
    });
    expect(result).toEqual({ status: 'registered' });
    expect(sent).toEqual([['device.setPushToken', { token: 'ExponentPushToken[abc]' }]]);
    expect(registrationNote(result)).toBeNull();
  });

  it('names every reason a push will not arrive, and sends nothing', async () => {
    const cases: [Partial<PushPlatform>, RegExp][] = [
      [{ executionEnvironment: 'storeClient' }, /development build/],
      [{ isDevice: false }, /physical device/],
      [{ projectId: undefined }, /EAS project id/],
      [{ projectId: '  ' }, /EAS project id/],
      [{ getPermissions: async () => ({ status: 'denied' }), requestPermissions: async () => ({ status: 'denied' }) }, /Settings/],
      [{ getToken: async () => { throw new Error('APNs unreachable'); } }, /APNs unreachable/],
    ];
    for (const [over, note] of cases) {
      let sent = false;
      const result = await registerWith(platform(over), async () => {
        sent = true;
      });
      expect(result.status).not.toBe('registered');
      expect(registrationNote(result)).toMatch(note);
      expect(sent).toBe(false);
    }
  });

  it('reports a Mac that refused the token', async () => {
    const result = await registerWith(platform(), async () => {
      throw new Error('Unknown device.');
    });
    expect(result).toEqual({ status: 'failed', message: 'Unknown device.' });
  });
});
