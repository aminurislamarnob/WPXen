import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Push with the app closed needs the EAS project id in extra.eas.projectId
// and the expo-notifications plugin with background remote notifications;
// app.json had neither, so a build could never mint a push token.

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(mobileRoot, 'package.json'));
const appJson = require('./app.json');
const appConfig = require('./app.config.js');

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('app.config.js', () => {
  it('reads the EAS project id from the environment', () => {
    process.env.EAS_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
    const config = appConfig({ config: appJson.expo });
    expect(config.extra.eas.projectId).toBe('00000000-0000-0000-0000-000000000000');
    // Everything app.json says survives.
    expect(config.ios.bundleIdentifier).toBe(appJson.expo.ios.bundleIdentifier);
  });

  it('commits no project id of its own', () => {
    delete process.env.EAS_PROJECT_ID;
    expect(appConfig({ config: appJson.expo }).extra.eas.projectId).toBeUndefined();
  });

  it('configures expo-notifications for background remote notifications', () => {
    const plugins = appConfig({ config: appJson.expo }).plugins;
    const notifications = plugins.filter(
      (p: unknown) => p === 'expo-notifications' || (Array.isArray(p) && p[0] === 'expo-notifications')
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0][1]).toMatchObject({ enableBackgroundRemoteNotifications: true, mode: 'development' });
    process.env.WPXEN_APS_ENVIRONMENT = 'production';
    expect(
      appConfig({ config: appJson.expo }).plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-notifications')[1].mode
    ).toBe('production');
  });
});
