import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useLocalSearchParams } from 'expo-router';
import { HostConnection } from '../../../../connection/manager';
import { findHost } from '../../../../hosts/hostList';
import { loadDeviceKeys, loadHosts } from '../../../../hosts/secureHosts';
import { KEY_BAR_ORDER, keyBytes, pressWithCtrlArmed, type KeyId } from '../../../../terminal/keyBar';
import { buildTerminalHtml } from '../../../../terminal/terminalWebView';

interface Outgoing {
  type: 'init' | 'write' | 'reset' | 'theme';
  theme?: 'dark' | 'light';
  data?: string;
}

const KEY_LABELS: Record<KeyId, string> = {
  esc: 'Esc',
  tab: 'Tab',
  'ctrl-c': 'Ctrl-C',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  enter: 'Enter',
};

export default function SessionTerminalScreen() {
  const { id, sessionId } = useLocalSearchParams<{ id: string; sessionId: string }>();
  const appearance = useColorScheme();
  const theme: 'light' | 'dark' = appearance === 'light' ? 'light' : 'dark';
  const [missing, setMissing] = useState(false);
  const [exited, setExited] = useState<number | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const connection = useRef<HostConnection | null>(null);
  const wasConnected = useRef(false);
  const webView = useRef<WebView | null>(null);
  const input = useRef<TextInput | null>(null);
  const ready = useRef(false);
  const generation = useRef(0);
  const queue = useRef<Outgoing[]>([]);
  const attached = useRef(false);
  const themeRef = useRef(theme);

  const post = useCallback((msg: Outgoing) => {
    if (!ready.current) {
      queue.current.push(msg);
      return;
    }
    webView.current?.postMessage(JSON.stringify(msg));
  }, []);

  const sendWrite = useCallback(
    (data: string) => {
      connection.current?.request('terminal.write', { sessionId, data }).catch(() => {});
    },
    [sessionId]
  );

  const attach = useCallback(async () => {
    const conn = connection.current;
    if (!conn) return;
    try {
      await conn.request('terminal.attach', { sessionId });
      attached.current = true;
    } catch {
      // Retry rides the reconnect loop; the replay lands on success.
    }
  }, [sessionId]);

  const detach = useCallback(async () => {
    attached.current = false;
    try {
      await connection.current?.request('terminal.detach', { sessionId });
    } catch {
      // Leaving anyway; the socket close cleans up server-side.
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const host = findHost(await loadHosts(), id);
      const keys = host ? await loadDeviceKeys(host.id) : null;
      if (!host || !keys) {
        setMissing(true);
        return;
      }
      if (cancelled) return;
      const conn = new HostConnection({
        host,
        deviceId: host.id,
        keys,
        onUpdate: (u) => {
          if (cancelled) return;
          // Heartbeats re-emit connected; re-attach only on entry so the
          // replay does not reset the document every 30 seconds.
          const entered = u.state === 'connected' && !wasConnected.current;
          wasConnected.current = u.state === 'connected';
          if (entered) attach();
        },
      });
      connection.current = conn;
      conn.subscribe('terminal.replay', (payload) => {
        if (cancelled) return;
        const replay = payload as { sessionId?: string; data?: string; exited?: boolean };
        if (replay.sessionId !== sessionId) return;
        generation.current += 1;
        queue.current = [];
        post({ type: 'reset' });
        post({ type: 'write', data: replay.data ?? '' });
      });
      conn.subscribe('terminal.data', (payload) => {
        if (cancelled) return;
        const data = payload as { sessionId?: string; data?: string };
        if (data.sessionId !== sessionId || typeof data.data !== 'string') return;
        post({ type: 'write', data: data.data });
      });
      conn.subscribe('terminal.exit', (payload) => {
        if (cancelled) return;
        const exit = payload as { sessionId?: string; code?: number };
        if (exit.sessionId !== sessionId) return;
        setExited(typeof exit.code === 'number' ? exit.code : 0);
      });
      conn.start();
    })();
    return () => {
      cancelled = true;
      detach();
      connection.current?.stop();
      connection.current = null;
    };
  }, [id, sessionId, attach, detach, post]);

  // Appearance flips re-theme the live document.
  useEffect(() => {
    themeRef.current = theme;
    post({ type: 'theme', theme });
  }, [theme, post]);

  const onWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        ready.current = true;
        post({ type: 'init', theme: themeRef.current });
        const queued = queue.current;
        queue.current = [];
        for (const item of queued) post(item);
      }
    },
    [post]
  );

  const onTypedText = useCallback(
    (text: string) => {
      if (!text || exited !== null) return;
      const { bytes, ctrlArmed: stillArmed } = pressWithCtrlArmed({ text }, ctrlArmed);
      setCtrlArmed(stillArmed);
      sendWrite(bytes);
    },
    [ctrlArmed, exited, sendWrite]
  );

  const onKeyBar = useCallback(
    (key: KeyId) => {
      if (exited !== null) return;
      if (key === 'ctrl-c') {
        setCtrlArmed(false);
        sendWrite(keyBytes('ctrl-c'));
        return;
      }
      setCtrlArmed(false);
      sendWrite(keyBytes(key));
    },
    [exited, sendWrite]
  );

  if (missing) {
    return (
      <View style={styles.center}>
        <Text style={styles.body}>That Mac is no longer paired.</Text>
      </View>
    );
  }

  const html = buildTerminalHtml({ theme });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {exited !== null && (
        <View style={styles.exitBanner}>
          <Text style={styles.exitText}>Session exited ({exited}) — read-only.</Text>
        </View>
      )}
      <Pressable style={styles.terminal} onPress={() => input.current?.focus()}>
        {loadError ? (
          <View style={styles.center}>
            <Text style={styles.body}>The terminal engine failed to load.</Text>
          </View>
        ) : (
          <WebView
            ref={webView}
            source={{ html }}
            originWhitelist={['*']}
            javaScriptEnabled
            scrollEnabled={false}
            textZoom={100}
            onMessage={onWebViewMessage}
            onError={() => setLoadError(true)}
            onHttpError={() => setLoadError(true)}
          />
        )}
      </Pressable>
      {exited === null && (
        <>
          <TextInput
            ref={input}
            style={styles.hiddenInput}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={onTypedText}
            value=""
          />
          <View style={styles.keyBar}>
            {KEY_BAR_ORDER.filter((key) => key !== 'ctrl-c').map((key) => (
              <Pressable key={key} style={styles.key} onPress={() => onKeyBar(key)}>
                <Text style={styles.keyLabel}>{KEY_LABELS[key]}</Text>
              </Pressable>
            ))}
            <Pressable
              style={[styles.key, styles.ctrlKey]}
              onPress={() => setCtrlArmed((armed) => !armed)}
            >
              <Text style={[styles.keyLabel, ctrlArmed && styles.ctrlArmed]}>Ctrl</Text>
            </Pressable>
            <Pressable style={styles.key} onPress={() => onKeyBar('ctrl-c')}>
              <Text style={styles.keyLabel}>Ctrl-C</Text>
            </Pressable>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  body: { fontSize: 14, opacity: 0.7, textAlign: 'center' },
  exitBanner: { padding: 10, backgroundColor: '#3a3a3c' },
  exitText: { color: '#fff', fontSize: 13, textAlign: 'center' },
  terminal: { flex: 1 },
  hiddenInput: { height: 0, width: 0, opacity: 0 },
  keyBar: { flexDirection: 'row', padding: 8, gap: 6, backgroundColor: '#1c1c1e' },
  key: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
  },
  ctrlKey: { flex: 1.2 },
  keyLabel: { color: '#fff', fontSize: 13, fontWeight: '600' },
  ctrlArmed: { color: '#0a84ff' },
});
