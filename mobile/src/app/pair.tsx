import { useState } from 'react';
import { Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { addHost } from '../hosts/hostList';
import { loadHosts, saveDeviceKeys, saveHosts } from '../hosts/secureHosts';
import { pairFailureMessage, pairWithLink, type PairFailureReason } from '../pairing/pair';

type Phase =
  | { name: 'scan' }
  | { name: 'waiting'; code: string }
  | { name: 'failed'; reason: PairFailureReason };

export default function PairScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ name: 'scan' });
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);

  const startPairing = async (pairingLink: string) => {
    if (busy) return;
    setBusy(true);
    setPhase({ name: 'scan' });
    const deviceName = Device.deviceName ?? 'Phone';
    const platform = Device.osName ?? 'unknown';
    const result = await pairWithLink({
      link: pairingLink,
      deviceName,
      platform,
      onCode: (code) => setPhase({ name: 'waiting', code }),
    });
    setBusy(false);
    if (result.ok) {
      await saveDeviceKeys(result.host.id, result.keys);
      await saveHosts(addHost(await loadHosts(), result.host));
      router.replace('/');
    } else {
      setPhase({ name: 'failed', reason: result.reason });
    }
  };

  if (!permission?.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.body}>The camera scans the Mac’s QR code. The simulator has no camera — paste the link instead.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
        <Text style={styles.label}>Or paste a pairing link</Text>
        <TextInput
          style={styles.input}
          value={link}
          onChangeText={setLink}
          placeholder="wpxen://pair?..."
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button title="Pair" disabled={busy || !link.trim()} onPress={() => startPairing(link)} />
        {phase.name === 'failed' && <Text style={styles.error}>{pairFailureMessage(phase.reason)}</Text>}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {phase.name === 'waiting' ? (
        <View style={styles.center}>
          <Text style={styles.code}>{phase.code}</Text>
          <Text style={styles.body}>Check the Mac shows the same code, then allow it there.</Text>
        </View>
      ) : (
        <>
          <CameraView
            style={styles.camera}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(event) => startPairing(event.data)}
          />
          <Text style={styles.label}>Or paste a pairing link (simulator, accessibility)</Text>
          <TextInput
            style={styles.input}
            value={link}
            onChangeText={setLink}
            placeholder="wpxen://pair?..."
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button title="Pair" disabled={busy || !link.trim()} onPress={() => startPairing(link)} />
        </>
      )}
      {phase.name === 'failed' && <Text style={styles.error}>{pairFailureMessage(phase.reason)}</Text>}
      {busy && phase.name === 'scan' && <Text style={styles.body}>Contacting the Mac…</Text>}
      <Pressable onPress={() => router.back()}>
        <Text style={styles.cancel}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  camera: { height: 280, borderRadius: 12, overflow: 'hidden' },
  code: { fontSize: 56, fontWeight: '700', letterSpacing: 8 },
  body: { fontSize: 14, opacity: 0.7, textAlign: 'center' },
  label: { fontSize: 13, fontWeight: '600', marginTop: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, fontSize: 14 },
  error: { fontSize: 14, color: '#c00' },
  cancel: { fontSize: 14, opacity: 0.6, textAlign: 'center', marginTop: 8 },
});
