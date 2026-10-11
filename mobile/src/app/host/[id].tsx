import { useEffect, useRef, useState } from 'react';
import { Alert, Button, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HostConnection, type ConnectionUpdate } from '../../connection/manager';
import { findHost, removeHost } from '../../hosts/hostList';
import { deleteHostSecrets, loadDeviceKeys, loadHosts, saveHosts } from '../../hosts/secureHosts';

function stateLabel(update: ConnectionUpdate | null, lastSeen: number | null): string {
  if (!update) return 'Connecting…';
  switch (update.state) {
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'offline': {
      const at = update.lastSeenAt ?? lastSeen;
      if (at == null) return 'Mac offline';
      const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
      return minutes < 1 ? 'Mac offline (last seen just now)' : `Mac offline (last seen ${minutes} min ago)`;
    }
    case 'asleep':
      return 'Mac asleep';
    case 'revoked':
      return 'Removed from WPXen';
  }
}

export default function HostScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [update, setUpdate] = useState<ConnectionUpdate | null>(null);
  const [name, setName] = useState('Mac');
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);

  const connection = useRef<HostConnection | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hosts = await loadHosts();
      const host = findHost(hosts, id);
      if (!host) {
        setMissing(true);
        return;
      }
      const keys = await loadDeviceKeys(host.id);
      if (!keys) {
        setMissing(true);
        return;
      }
      if (cancelled) return;
      setName(host.name);
      setLastSeen(host.lastSeen);
      const conn = new HostConnection({
        host,
        deviceId: host.id,
        keys,
        onUpdate: (u) => {
          if (!cancelled) {
            setUpdate(u);
            if (u.lastSeenAt != null) setLastSeen(u.lastSeenAt);
          }
        },
      });
      connection.current = conn;
      conn.start();
    })();
    return () => {
      cancelled = true;
      connection.current?.stop();
      connection.current = null;
    };
  }, [id]);

  const remove = () => {
    Alert.alert('Remove Mac?', `Forget ${name}? Its secrets are deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          connection.current?.stop();
          await deleteHostSecrets(id);
          await saveHosts(removeHost(await loadHosts(), id));
          router.replace('/');
        },
      },
    ]);
  };

  if (missing) {
    return (
      <View style={styles.container}>
        <Text style={styles.body}>That Mac is no longer paired.</Text>
        <Button title="Back to Macs" onPress={() => router.replace('/')} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.state}>{stateLabel(update, lastSeen)}</Text>
      {update?.state === 'connected' && update.rttMs != null && (
        <Text style={styles.body}>Ping round-trip: {Math.round(update.rttMs)} ms, encrypted end to end.</Text>
      )}
      {update?.state === 'revoked' && (
        <Text style={styles.body}>This device was removed from WPXen. Pair again from Settings → Mobile.</Text>
      )}
      <View style={styles.spacer} />
      <Button title="Remove Mac" color="#c00" onPress={remove} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  state: { fontSize: 16, fontWeight: '500' },
  body: { fontSize: 14, opacity: 0.7 },
  spacer: { flex: 1 },
});
