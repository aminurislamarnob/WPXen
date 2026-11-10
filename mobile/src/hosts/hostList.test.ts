import { describe, expect, it } from 'vitest';
import { addHost, findHost, removeHost, touchHost, type HostRecord } from './hostList';

const mac = (over: Partial<HostRecord> = {}): HostRecord => ({
  id: 'device-1',
  name: 'Studio Mac',
  url: 'wss://wpxen.example.com/wpxen-device',
  hostId: 'host-1',
  hostPublicKey: 'a2V5',
  lastSeen: null,
  ...over,
});

describe('hostList', () => {
  it('adds a host', () => {
    expect(addHost([], mac())).toEqual([mac()]);
  });

  it('replaces on re-pair instead of doubling', () => {
    const next = addHost([mac()], mac({ name: 'Studio Mac Pro', lastSeen: 5 }));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: 'Studio Mac Pro', lastSeen: 5 });
  });

  it('removes by id and leaves the rest', () => {
    const list = addHost([mac()], mac({ id: 'device-2', name: 'Air' }));
    expect(removeHost(list, 'device-1').map((h) => h.id)).toEqual(['device-2']);
    expect(removeHost(list, 'missing')).toHaveLength(2);
  });

  it('touches last seen without disturbing the rest', () => {
    const list = addHost([mac()], mac({ id: 'device-2' }));
    const next = touchHost(list, 'device-1', 42);
    expect(next.find((h) => h.id === 'device-1')?.lastSeen).toBe(42);
    expect(next.find((h) => h.id === 'device-2')?.lastSeen).toBeNull();
  });

  it('takes the machine name the Mac reports on contact, keeping it when none is sent', () => {
    const list = [mac({ name: 'Old Name' })];
    expect(touchHost(list, 'device-1', 7, 'Studio Mac')[0]).toMatchObject({ name: 'Studio Mac', lastSeen: 7 });
    expect(touchHost(list, 'device-1', 8, null)[0]).toMatchObject({ name: 'Old Name', lastSeen: 8 });
    expect(touchHost(list, 'device-1', 9, '  ')[0].name).toBe('Old Name');
  });

  it('finds by id', () => {
    expect(findHost([mac()], 'device-1')).toMatchObject({ name: 'Studio Mac' });
    expect(findHost([], 'device-1')).toBeNull();
  });
});
