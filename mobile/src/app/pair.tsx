import { useEffect, useState } from 'react';
import { Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { addHost } from '../hosts/hostList';
import { loadHosts, saveDeviceKeys, saveHosts } from '../hosts/secureHosts';
import { pairFailureMessage, pairWithLink, type PairFailureReason } from '../pairing/pair';
import { createPairingAttempts } from '../pairing/attempts';
import { pairView } from '../pairing/view';

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
  // One attempt at a time, guarded before the first await (attempts.ts);
  // leaving the screen aborts whatever is still running.
  const [attempts] = useState(createPairingAttempts);
  useEffect(() => () => attempts.cancel(), [attempts]);

  const startPairing = async (pairingLink: string) => {
    const attempt = attempts.begin();
    if (!attempt) return;
    setBusy(true);
    setPhase({ name: 'scan' });
    const deviceName = Device.deviceName ?? 'Phone';
    const platform = Device.osName ?? 'unknown';
    const result = await pairWithLink({
      link: pairingLink,
      deviceName,
      platform,
      signal: attempt.signal,
      onCode: (code) => {
        if (attempts.isCurrent(attempt.id)) setPhase({ name: 'waiting', code });
      },
    });
    // Cancelled or replaced: the screen it would report to is gone.
    if (!attempts.end(attempt.id)) return;
    setBusy(false);
    if (result.ok) {
      await saveDeviceKeys(result.host.id, result.keys);
      await saveHosts(addHost(await loadHosts(), result.host));
      router.replace('/');
    } else {
      setPhase({ name: 'failed', reason: result.reason });
    }
  };

  const cancel = () => {
    attempts.cancel();
    router.back();
  };

  // The code and progress show whether the link was scanned or pasted
  // (view.ts): the paste path is the simulator's only one.
  const view = pairView({ phase: phase.name, cameraGranted: !!permission?.granted, busy });

  const pasteForm = (
    <>
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
  );

  return (
    <View style={styles.container}>
      {view.body === 'code' && phase.name === 'waiting' && (
        <View style={styles.center}>
          <Text style={styles.code}>{phase.code}</Text>
          <Text style={styles.body}>Check the Mac shows the same code, then allow it there.</Text>
        </View>
      )}
      {view.body === 'camera' && (
        <>
          <CameraView
            style={styles.camera}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            // Off while an attempt runs: the scanner keeps reporting the same QR.
            onBarcodeScanned={busy ? undefined : (event) => startPairing(event.data)}
          />
          <Text style={styles.label}>Or paste a pairing link (simulator, accessibility)</Text>
          {pasteForm}
        </>
      )}
      {view.body === 'paste' && (
        <>
          <Text style={styles.body}>The camera scans the Mac’s QR code. The simulator has no camera — paste the link instead.</Text>
          <Button title="Allow camera" onPress={requestPermission} />
          <Text style={styles.label}>Or paste a pairing link</Text>
          {pasteForm}
        </>
      )}
      {view.error && phase.name === 'failed' && <Text style={styles.error}>{pairFailureMessage(phase.reason)}</Text>}
      {view.progress && <Text style={styles.body}>Contacting the Mac…</Text>}
      <Pressable onPress={cancel}>
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
