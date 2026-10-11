import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { removeHost, type HostRecord } from '../hosts/hostList';
import { deleteHostSecrets, loadHosts, saveHosts } from '../hosts/secureHosts';

function lastSeenLabel(lastSeen: number | null): string {
  if (lastSeen == null) return 'never connected';
  const seconds = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
  if (seconds < 60) return 'seen just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `seen ${hours} h ago`;
  return `seen ${Math.floor(hours / 24)} d ago`;
}

export default function HostsScreen() {
  const router = useRouter();
  const [hosts, setHosts] = useState<HostRecord[]>([]);

  const reload = useCallback(async () => {
    setHosts(await loadHosts());
  }, []);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  const confirmRemove = (host: HostRecord) => {
    Alert.alert('Remove Mac?', `Forget ${host.name}? Its secrets are deleted and it will not reconnect.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await deleteHostSecrets(host.id);
          const next = removeHost(await loadHosts(), host.id);
          await saveHosts(next);
          setHosts(next);
        },
      },
    ]);
  };

  if (hosts.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No Macs yet</Text>
        <Text style={styles.emptyBody}>Open WPXen → Settings → Mobile → Pair a device, then scan the code.</Text>
        <Pressable style={styles.primary} onPress={() => router.push('/pair')}>
          <Text style={styles.primaryLabel}>Add Mac</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={hosts}
        keyExtractor={(h) => h.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/host/${encodeURIComponent(item.id)}`)}
            onLongPress={() => confirmRemove(item)}
          >
            <View style={styles.rowText}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.sub}>{lastSeenLabel(item.lastSeen)}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
      <Pressable style={styles.primary} onPress={() => router.push('/pair')}>
        <Text style={styles.primaryLabel}>Add Mac</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '600' },
  emptyBody: { fontSize: 14, opacity: 0.7, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#ccc' },
  rowText: { flex: 1 },
  name: { fontSize: 16, fontWeight: '500' },
  sub: { fontSize: 13, opacity: 0.6, marginTop: 2 },
  chevron: { fontSize: 20, opacity: 0.4 },
  primary: { backgroundColor: '#0a7aff', borderRadius: 10, padding: 12, alignItems: 'center', marginTop: 16 },
  primaryLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
