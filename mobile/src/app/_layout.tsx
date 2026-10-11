import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { installSecureRandom } from '../crypto';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    // tweetnacl needs a random source on React Native before any key work.
    installSecureRandom();
    SplashScreen.hideAsync();
  }, []);

  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'WPXen Mobile' }} />
      <Stack.Screen name="pair" options={{ title: 'Add Mac' }} />
      <Stack.Screen name="host/[id]" options={{ title: 'Mac' }} />
    </Stack>
  );
}
