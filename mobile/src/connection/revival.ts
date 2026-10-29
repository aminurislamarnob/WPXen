// OS signals that should make a down connection redial now instead of
// waiting out its backoff (after Orca's connection-revival-triggers.ts): the
// app returning to the foreground, and the network coming back or changing
// (networkChange.ts). Resume and handoffs can kill a socket without a close
// event, and suspend the retry timer while the app is away.

import { AppState } from 'react-native';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { networkChangeNudges, type NetworkSnapshot } from './networkChange';

export function subscribeRevivalTriggers(nudge: (reason: 'app-resume' | 'network-change') => void): () => void {
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') nudge('app-resume');
  });
  let last: NetworkSnapshot | null = null;
  let disposed = false;
  // Seed the baseline so the first offline → online change counts.
  getNetworkStateAsync()
    .then((state) => {
      if (!disposed && last == null) last = { isConnected: state.isConnected, type: state.type };
    })
    .catch(() => {});
  const networkSub = addNetworkStateListener((state) => {
    const next = { isConnected: state.isConnected, type: state.type };
    const nudges = networkChangeNudges(last, next);
    last = next;
    if (nudges) nudge('network-change');
  });
  return () => {
    disposed = true;
    appStateSub.remove();
    networkSub.remove();
  };
}
