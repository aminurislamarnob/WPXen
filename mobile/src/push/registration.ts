// Push registration, as a pure function of what the platform reports, so
// every way it can fail is named and shown instead of collapsing into a
// silent "skipped" (after Orca's notification-display-test.tsx, which tells
// the user why a push won't arrive). register.ts wires the real expo modules.

export type PushRegistration =
  | { status: 'registered' }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: 'expo-go' | 'simulator' | 'no-project-id' }
  | { status: 'failed'; message: string };

export interface PushPlatform {
  // Constants.executionEnvironment: 'storeClient' is Expo Go.
  executionEnvironment: string | undefined;
  isDevice: boolean;
  // Constants.expoConfig.extra.eas.projectId (app.config.js, EAS_PROJECT_ID).
  projectId: unknown;
  getPermissions: () => Promise<{ status: string }>;
  requestPermissions: () => Promise<{ status: string }>;
  getToken: (projectId: string) => Promise<{ data: string }>;
}

export async function registerWith(
  platform: PushPlatform,
  request: (op: string, params?: Record<string, unknown>) => Promise<unknown>
): Promise<PushRegistration> {
  // Expo Go can't carry this app's notification config or project.
  if (platform.executionEnvironment === 'storeClient') {
    return { status: 'unavailable', reason: 'expo-go' };
  }
  if (!platform.isDevice) return { status: 'unavailable', reason: 'simulator' };
  const projectId = typeof platform.projectId === 'string' ? platform.projectId.trim() : '';
  if (!projectId) return { status: 'unavailable', reason: 'no-project-id' };
  try {
    const { status: existing } = await platform.getPermissions();
    const status = existing === 'granted' ? existing : (await platform.requestPermissions()).status;
    if (status !== 'granted') return { status: 'denied' };
    const token = (await platform.getToken(projectId)).data;
    if (!token) return { status: 'failed', message: 'No push token was issued.' };
    await request('device.setPushToken', { token });
    return { status: 'registered' };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

// What the host screen says under the notifications switch; null when
// pushes will arrive.
export function registrationNote(result: PushRegistration | null): string | null {
  if (!result) return null;
  switch (result.status) {
    case 'registered':
      return null;
    case 'denied':
      return 'Notifications are off for this app in the phone’s Settings.';
    case 'unavailable':
      if (result.reason === 'expo-go') return 'Push needs a development build of WPXen Mobile — Expo Go can’t receive it.';
      if (result.reason === 'simulator') return 'Push needs a physical device.';
      return 'Push isn’t set up in this build (no EAS project id).';
    case 'failed':
      return `Couldn’t register for push: ${result.message}`;
  }
}
