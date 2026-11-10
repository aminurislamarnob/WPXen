// OS signals that should make a connection check itself now instead of
// waiting out its backoff or its next heartbeat (after Orca's
// connection-revival-triggers.ts): a real return from the background
// (resumeGate.ts) and any network event while connected (networkChange.ts).
// Resume and handoffs can kill a socket without a close event, and suspend
// the retry timer while the app is away.

import { AppState } from 'react-native';
import { addNetworkStateListener } from 'expo-network';
import { networkChangeNudges } from './networkChange';
import { createResumeGate } from './resumeGate';

export type RevivalReason = 'app-resume' | 'network-change';

export function subscribeRevivalTriggers(nudge: (reason: RevivalReason) => void): () => void {
  const resumed = createResumeGate(AppState.currentState);
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (resumed(next)) nudge('app-resume');
  });
  const networkSub = addNetworkStateListener((state) => {
    if (networkChangeNudges({ isConnected: state.isConnected, type: state.type })) nudge('network-change');
  });
  return () => {
    appStateSub.remove();
    networkSub.remove();
  };
}
