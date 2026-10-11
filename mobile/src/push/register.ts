// Push registration: after pairing (and whenever the token may have
// changed) the phone asks for permission and hands its Expo push token to
// the Mac over the encrypted channel. Everything degrades to a skip —
// missing permission, no EAS project, or offline all mean "no pushes",
// never a crash.

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

export type PushRegistration = 'registered' | 'denied' | 'skipped';

export async function registerPushToken(
  request: (op: string, params?: Record<string, unknown>) => Promise<unknown>
): Promise<PushRegistration> {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    const status =
      existing === 'granted' ? existing : (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return 'denied';
    const projectId = Constants?.expoConfig?.extra?.eas?.projectId;
    const token = (
      await Notifications.getExpoPushTokenAsync(
        typeof projectId === 'string' && projectId ? { projectId } : undefined
      )
    ).data;
    if (!token) return 'skipped';
    await request('device.setPushToken', { token });
    return 'registered';
  } catch {
    return 'skipped';
  }
}
