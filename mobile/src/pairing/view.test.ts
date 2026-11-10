import { describe, expect, it } from 'vitest';
import { pairView } from './view';

describe('pair screen view', () => {
  it('shows the code while waiting, with or without the camera', () => {
    expect(pairView({ phase: 'waiting', cameraGranted: true, busy: true }).body).toBe('code');
    expect(pairView({ phase: 'waiting', cameraGranted: false, busy: true }).body).toBe('code');
  });

  it('shows progress after a paste with no camera permission', () => {
    expect(pairView({ phase: 'scan', cameraGranted: false, busy: true })).toEqual({
      body: 'paste',
      progress: true,
      error: false,
    });
  });

  it('shows the scanner when the camera is allowed, and errors either way', () => {
    expect(pairView({ phase: 'scan', cameraGranted: true, busy: false }).body).toBe('camera');
    expect(pairView({ phase: 'failed', cameraGranted: false, busy: false }).error).toBe(true);
    expect(pairView({ phase: 'failed', cameraGranted: true, busy: false }).error).toBe(true);
  });
});
