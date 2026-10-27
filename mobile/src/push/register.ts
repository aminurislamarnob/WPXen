// Push registration: after pairing (and whenever the token may have
// changed) the phone asks for permission and hands its Expo push token to
// the Mac over the encrypted channel. The outcome is returned, never
// swallowed — the host screen shows why a push won't arrive (registration.ts).

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { registerWith, type PushRegistration } from './registration';

export type { PushRegistration };

export function registerPushToken(
  request: (op: string, params?: Record<string, unknown>) => Promise<unknown>
): Promise<PushRegistration> {
  return registerWith(
    {
      executionEnvironment: Constants.executionEnvironment,
      isDevice: Device.isDevice,
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
      getPermissions: () => Notifications.getPermissionsAsync(),
      requestPermissions: () => Notifications.requestPermissionsAsync(),
      getToken: (projectId) => Notifications.getExpoPushTokenAsync({ projectId }),
    },
    request
  );
}
