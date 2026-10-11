import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type LayoutChangeEvent,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useLocalSearchParams } from 'expo-router';
import { HostConnection } from '../../../../connection/manager';
import { findHost } from '../../../../hosts/hostList';
import {
  loadDeviceKeys,
  loadHosts,
  loadTextSize,
  saveTextSize,
} from '../../../../hosts/secureHosts';
import { KEY_BAR_ORDER, keyBytes, pressWithCtrlArmed, type KeyId } from '../../../../terminal/keyBar';
import { buildTerminalHtml, TERMINAL_FONT_SIZE } from '../../../../terminal/terminalWebView';
import { decideResize, type ResizeDims } from '../../../../terminal/resizePolicy';

interface Outgoing {
  type: 'init' | 'write' | 'reset' | 'theme' | 'grid' | 'font-size';
  theme?: 'dark' | 'light';
  data?: string;
  cols?: number;
  rows?: number;
  fontSize?: number;
}

// Phone grid from the measured frame: ~0.6 cell aspect, ~1.35 line pitch at
// the live font size. An approximation (the document owns exact metrics),
// clamped into the op's bounds — rotation and frame changes re-measure.
function estimateDims(width: number, height: number, fontSize: number): ResizeDims {
  const cols = Math.max(20, Math.min(500, Math.floor(width / (fontSize * 0.6))));
  const rows = Math.max(8, Math.min(500, Math.floor(height / (fontSize * 1.35))));
  return { cols, rows };
}

const KEYBOARD_SETTLE_MS = 500;
const FONT_APPLY_MS = 150;
const MIN_TEXT_SIZE = 10;
const MAX_TEXT_SIZE = 20;

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
  const [fontSize, setFontSize] = useState(TERMINAL_FONT_SIZE);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const connection = useRef<HostConnection | null>(null);
  const wasConnected = useRef(false);
  const lastSentDims = useRef<ResizeDims | null>(null);
  const reconnected = useRef(false);
  const keyboardAt = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maybeResizeRef = useRef<() => void>(() => {});
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

  // The device actively viewing owns the pty size: fit the frame, unless
  // covered, backgrounded, or mid-keyboard-transition (defer and retry once
  // the keyboard settles — after Orca terminal-viewport-refit).
  const maybeResize = useCallback(
    (opts: { textSizeChanged?: boolean } = {}) => {
      const measured = frame;
      if (!measured || exited !== null) return;
      const dims = estimateDims(measured.width, measured.height, fontSize);
      const decision = decideResize({
        visible: true,
        covered: false,
        appState: AppState.currentState,
        keyboardTransitioning: Date.now() - keyboardAt.current < KEYBOARD_SETTLE_MS,
        dims,
        lastSentDims: lastSentDims.current,
        reconnected: reconnected.current,
        textSizeChanged: opts.textSizeChanged ?? false,
      });
      reconnected.current = false;
      if (decision === 'skip') return;
      if (decision === 'defer') {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => maybeResizeRef.current(), 400);
        return;
      }
      lastSentDims.current = dims;
      post({ type: 'grid', cols: dims.cols, rows: dims.rows });
      connection.current?.request('terminal.resize', { sessionId, cols: dims.cols, rows: dims.rows }).catch(() => {});
    },
    [frame, fontSize, exited, sessionId, post]
  );

  useEffect(() => {
    maybeResizeRef.current = () => maybeResize();
  }, [maybeResize]);

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
      setFontSize(await loadTextSize(host.id));
      const conn = new HostConnection({
        host,
        deviceId: host.id,
        keys,
        onUpdate: (u) => {
          if (cancelled) return;
          // Heartbeats re-emit connected; re-attach only on entry so the
          // replay does not reset the document every 30 seconds. A fresh
          // entry also re-asserts the size: the desktop may have resized
          // the pty while the socket was down.
          const entered = u.state === 'connected' && !wasConnected.current;
          wasConnected.current = u.state === 'connected';
          if (entered) {
            reconnected.current = true;
            attach();
            maybeResize();
          }
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
    // Keyboard transitions only move height: stamp them so layout churn
    // while the keyboard settles defers instead of resizing mid-keystroke.
    const markKeyboard = () => {
      keyboardAt.current = Date.now();
    };
    const settleKeyboard = () => {
      keyboardAt.current = Date.now();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => maybeResize(), 400);
    };
    const showSub = Keyboard.addListener('keyboardDidShow', settleKeyboard);
    const hideSub = Keyboard.addListener('keyboardDidHide', settleKeyboard);
    const willSub =
      Platform.OS === 'ios' ? Keyboard.addListener('keyboardWillShow', markKeyboard) : null;
    // Returning to the terminal re-measures: rotation, fold, or a desktop
    // resize may have moved everything while away.
    const appSub = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        reconnected.current = true;
        maybeResize();
      }
    });
    return () => {
      cancelled = true;
      showSub.remove();
      hideSub.remove();
      willSub?.remove();
      appSub.remove();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      detach();
      connection.current?.stop();
      connection.current = null;
    };
  }, [id, sessionId, attach, detach, post, maybeResize]);

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

  const onFrameLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setFrame((prev) => {
        if (prev && Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1) {
          return prev;
        }
        return { width, height };
      });
    },
    []
  );

  // Re-fit on every measured frame (open, rotation, fold). The policy drops
  // no-op and keyboard-transition layouts.
  useEffect(() => {
    if (frame) maybeResize();
  }, [frame, maybeResize]);

  const changeTextSize = useCallback(
    (delta: number) => {
      setFontSize((current) => {
        const next = Math.max(MIN_TEXT_SIZE, Math.min(MAX_TEXT_SIZE, current + delta));
        if (next === current) return current;
        loadHosts()
          .then((hosts) => {
            const host = findHost(hosts, id);
            if (host) saveTextSize(host.id, next);
          })
          .catch(() => {});
        // The document applies the font first; only then do cell metrics
        // exist to re-measure against (after Orca's text-size debounce).
        setTimeout(() => {
          post({ type: 'font-size', fontSize: next });
          setTimeout(() => maybeResize({ textSizeChanged: true }), FONT_APPLY_MS);
        }, 0);
        return next;
      });
    },
    [id, maybeResize, post]
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
      <Pressable style={styles.terminal} onPress={() => input.current?.focus()} onLayout={onFrameLayout}>
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
          <View style={styles.sizeRow}>
            <Pressable style={styles.sizeKey} onPress={() => changeTextSize(-1)}>
              <Text style={styles.keyLabel}>A−</Text>
            </Pressable>
            <Text style={styles.sizeLabel}>{fontSize}</Text>
            <Pressable style={styles.sizeKey} onPress={() => changeTextSize(1)}>
              <Text style={styles.keyLabel}>A+</Text>
            </Pressable>
          </View>
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
  sizeRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, gap: 8, backgroundColor: '#1c1c1e' },
  sizeKey: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#2c2c2e' },
  sizeLabel: { color: '#fff', fontSize: 12, minWidth: 20, textAlign: 'center' },
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
