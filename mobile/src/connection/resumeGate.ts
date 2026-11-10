// Whether an AppState change is a real return from the background (after
// Orca's connection-revival-triggers.ts, 0a75796a038). iOS goes
// active → inactive → active for Control Center, Notification Center, the
// app switcher peek and system alerts; none of those suspend the app or its
// socket, so probing on them only risks cutting a healthy connection over a
// slow tunnel. Only 'background' suspends the app, so only active after a
// background stay nudges. Pure, so it is tested; the AppState listener lives
// in revival.ts.

export type AppStateName = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

export function createResumeGate(initial: AppStateName | string | null | undefined): (next: AppStateName | string) => boolean {
  let wasBackgrounded = initial === 'background';
  return (next) => {
    if (next === 'background') {
      wasBackgrounded = true;
      return false;
    }
    if (next === 'active' && wasBackgrounded) {
      wasBackgrounded = false;
      return true;
    }
    return false;
  };
}
