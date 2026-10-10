// Host persistence. Everything secret (this device's keypair per host)
// lives in the platform secure store; the host list itself holds no secrets
// but rides along in the same store rather than adding an AsyncStorage
// dependency for one small JSON list.

import * as SecureStore from 'expo-secure-store';
import type { HostRecord } from './hostList';

const HOSTS_KEY = 'wpxen.hosts.v1';
const keyFor = (deviceId: string): string => `wpxen.keys.${deviceId}`;

export interface DeviceKeys {
  publicKey: string;
  secretKey: string;
}

export async function loadHosts(): Promise<HostRecord[]> {
  try {
    const raw = await SecureStore.getItemAsync(HOSTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveHosts(hosts: HostRecord[]): Promise<void> {
  await SecureStore.setItemAsync(HOSTS_KEY, JSON.stringify(hosts));
}

export async function saveDeviceKeys(deviceId: string, keys: DeviceKeys): Promise<void> {
  await SecureStore.setItemAsync(keyFor(deviceId), JSON.stringify(keys));
}

export async function loadDeviceKeys(deviceId: string): Promise<DeviceKeys | null> {
  try {
    const raw = await SecureStore.getItemAsync(keyFor(deviceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.publicKey === 'string' && typeof parsed?.secretKey === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Removing a host deletes its secrets with it: keys, then the row.
export async function deleteHostSecrets(deviceId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(keyFor(deviceId));
  } catch {
    // Already gone.
  }
}
