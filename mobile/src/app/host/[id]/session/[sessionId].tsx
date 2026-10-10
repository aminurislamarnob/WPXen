import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

// Placeholder: opening a Session marks it read; the terminal ticket replaces
// this screen with the live terminal.
export default function SessionPlaceholder() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Session</Text>
      <Text style={styles.body} numberOfLines={1}>
        {sessionId}
      </Text>
      <Text style={styles.body}>Terminal coming soon.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700' },
  body: { fontSize: 14, opacity: 0.7, textAlign: 'center' },
});
