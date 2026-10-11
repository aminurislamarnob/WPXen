import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { installSecureRandom } from '../crypto';
import { loadHosts } from '../hosts/secureHosts';

SplashScreen.preventAutoHideAsync();

interface PushData {
  hostId?: string;
  sessionId?: string;
}

async function hostDeviceIdForPush(hostId: string): Promise<string | null> {
  try {
    const hosts = await loadHosts();
    return hosts.find((h) => h.hostId === hostId)?.id ?? null;
  } catch {
    return null;
  }
}

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    // tweetnacl needs a random source on React Native before any key work.
    installSecureRandom();
    SplashScreen.hideAsync();
    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('default', {
        name: 'WPXen alerts',
        importance: Notifications.AndroidImportance.HIGH,
      }).catch(() => {});
    }
  }, []);

  // A tap lands on the Session it names: the Screens connect first when the
  // socket is down, so navigation alone is enough. Cold starts resolve the
  // tap that opened the app the same way.
  useEffect(() => {
    const openPush = async (data: PushData | undefined) => {
      if (!data?.hostId || !data?.sessionId) return;
      const deviceId = await hostDeviceIdForPush(data.hostId);
      if (!deviceId) return;
      router.replace({
        pathname: '/host/[id]/session/[sessionId]',
        params: { id: deviceId, sessionId: data.sessionId },
      });
    };
    Notifications.getLastNotificationResponseAsync()
      .then((response) => openPush(response?.notification.request.content.data as PushData))
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((response) =>
      openPush(response.notification.request.content.data as PushData).catch(() => {})
    );
    return () => sub.remove();
  }, [router]);

  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'WPXen Mobile' }} />
      <Stack.Screen name="pair" options={{ title: 'Add Mac' }} />
      <Stack.Screen name="host/[id]" options={{ title: 'Mac' }} />
      <Stack.Screen name="host/[id]/session/[sessionId]" options={{ title: 'Session' }} />
    </Stack>
  );
}
