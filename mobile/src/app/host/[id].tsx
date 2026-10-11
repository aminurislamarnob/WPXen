import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HostConnection, type ConnectionUpdate } from '../../connection/manager';
import { groupSessions, statusColor, type PhoneProject, type PhoneSessionRow } from '../../sessions/grouping';
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

function sessionSubtitle(session: PhoneSessionRow): string {
  const title = session.title || session.label || session.agentName;
  if (session.exited) return `${title} · exited ${session.exitCode ?? ''}`.trim();
  const pane = session.paneOf ? ' · pane' : '';
  return `${session.agentName} · ${title}${pane}`;
}

export default function HostScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [update, setUpdate] = useState<ConnectionUpdate | null>(null);
  const [name, setName] = useState('Mac');
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [projects, setProjects] = useState<PhoneProject[]>([]);
  const [sessions, setSessions] = useState<PhoneSessionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const connection = useRef<HostConnection | null>(null);
  const loadedOnce = useRef(false);

  const loadLists = useCallback(async () => {
    const conn = connection.current;
    if (!conn) return;
    try {
      const [projectsRes, sessionsRes] = await Promise.all([
        conn.request('projects.list') as Promise<{ projects: PhoneProject[] }>,
        conn.request('sessions.list') as Promise<{ sessions: PhoneSessionRow[] }>,
      ]);
      setProjects(projectsRes.projects ?? []);
      setSessions(sessionsRes.sessions ?? []);
      loadedOnce.current = true;
    } catch {
      // Offline: the stale list stays under the state banner.
    }
  }, []);

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
          if (cancelled) return;
          setUpdate(u);
          if (u.lastSeenAt != null) setLastSeen(u.lastSeenAt);
          if (u.state === 'connected' && !loadedOnce.current) loadLists();
        },
      });
      connection.current = conn;
      conn.subscribe('sessions.changed', (payload) => {
        if (cancelled) return;
        const rows = (payload as { sessions?: PhoneSessionRow[] })?.sessions;
        if (Array.isArray(rows)) setSessions(rows);
      });
      conn.start();
    })();
    return () => {
      cancelled = true;
      connection.current?.stop();
      connection.current = null;
    };
  }, [id, loadLists]);

  const openSession = async (session: PhoneSessionRow) => {
    try {
      await connection.current?.request('sessions.markRead', { sessionId: session.sessionId });
    } catch {
      // Reading is best-effort; the detail still opens.
    }
    router.push(`/host/${encodeURIComponent(id)}/session/${encodeURIComponent(session.sessionId)}`);
  };

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

  const live = update?.state === 'connected';
  const groups = groupSessions(projects, sessions);

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await loadLists();
            setRefreshing(false);
          }}
        />
      }
    >
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.state}>{stateLabel(update, lastSeen)}</Text>
      {update?.state === 'connected' && update.rttMs != null && (
        <Text style={styles.body}>Ping round-trip: {Math.round(update.rttMs)} ms, encrypted end to end.</Text>
      )}
      {update?.state === 'revoked' && (
        <Text style={styles.body}>This device was removed from WPXen. Pair again from Settings → Mobile.</Text>
      )}
      {!live && sessions.length > 0 && (
        <Text style={styles.stale}>Showing the last synced list — reconnecting.</Text>
      )}
      <View style={!live && sessions.length > 0 ? styles.dimmed : undefined}>
        {groups.map((group) => (
          <View key={group.key} style={styles.group}>
            <Text style={styles.groupTitle}>{group.title}</Text>
            {group.sessions.length === 0 ? (
              <Text style={styles.body}>Nothing here.</Text>
            ) : (
              group.sessions.map((session) => (
                <Pressable key={session.sessionId} style={styles.row} onPress={() => openSession(session)}>
                  <View style={[styles.dot, { backgroundColor: statusColor(session.state) }]} />
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, session.exited && styles.dimmedText]} numberOfLines={1}>
                      {session.title || session.label || session.agentName}
                    </Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {sessionSubtitle(session)}
                    </Text>
                  </View>
                  {session.unread && <View style={styles.unread} />}
                </Pressable>
              ))
            )}
          </View>
        ))}
      </View>
      <View style={styles.spacer} />
      <Button title="Remove Mac" color="#c00" onPress={remove} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  state: { fontSize: 16, fontWeight: '500', marginTop: 2 },
  body: { fontSize: 14, opacity: 0.7, marginTop: 4 },
  stale: { fontSize: 13, opacity: 0.7, marginTop: 8, fontStyle: 'italic' },
  dimmed: { opacity: 0.55 },
  dimmedText: { opacity: 0.6 },
  group: { marginTop: 16 },
  groupTitle: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', opacity: 0.6, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '500' },
  rowSub: { fontSize: 13, opacity: 0.6, marginTop: 1 },
  unread: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#0a7aff' },
  spacer: { height: 24 },
});
