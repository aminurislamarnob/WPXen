// What the pair screen shows, decided apart from the camera permission
// (after Orca 00666138a7e). The 4-digit code is the check against a swapped
// key — the user compares it with the Mac's before allowing — so the code and
// the progress line must show whether the link came from the camera or was
// pasted; the paste path is the only one on the simulator, and the one
// anyone who declined the camera has. Pure, so it is tested.

export type PairPhaseName = 'scan' | 'waiting' | 'failed';

export interface PairView {
  // 'code' replaces the inputs while the Mac asks Allow/Deny.
  body: 'code' | 'camera' | 'paste';
  progress: boolean;
  error: boolean;
}

export function pairView({
  phase,
  cameraGranted,
  busy,
}: {
  phase: PairPhaseName;
  cameraGranted: boolean;
  busy: boolean;
}): PairView {
  return {
    body: phase === 'waiting' ? 'code' : cameraGranted ? 'camera' : 'paste',
    progress: busy && phase === 'scan',
    error: phase === 'failed',
  };
}
