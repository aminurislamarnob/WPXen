// Stop streaming a terminal nobody can see (spec #146). After 30 s in the
// background — Orca's grace (mobile-relay-background-grace.ts), long enough
// to answer a notification or glance at another app without a replay on
// return — the phone unsubscribes from terminal output; back in the
// foreground it subscribes again, and the replay brings the screen up to
// date (after Orca's terminal-foreground-recovery.ts). Orca keeps streaming;
// the spec asks for this.

export const BACKGROUND_GRACE_MS = 30_000;

export type GracePhase = 'foreground' | 'grace' | 'detached';

export type GraceAction = 'start-grace' | 'cancel-grace' | 'unsubscribe' | 'resubscribe' | null;

export type GraceEvent = { type: 'app-state'; state: string } | { type: 'grace-expired' };

export function stepBackgroundGrace(phase: GracePhase, event: GraceEvent): { phase: GracePhase; action: GraceAction } {
  if (event.type === 'grace-expired') {
    return phase === 'grace' ? { phase: 'detached', action: 'unsubscribe' } : { phase, action: null };
  }
  // 'inactive' is iOS's transitional state (Control Center, the app
  // switcher, an incoming call banner): not away yet.
  if (event.state === 'background') {
    return phase === 'foreground' ? { phase: 'grace', action: 'start-grace' } : { phase, action: null };
  }
  if (event.state === 'active') {
    if (phase === 'grace') return { phase: 'foreground', action: 'cancel-grace' };
    if (phase === 'detached') return { phase: 'foreground', action: 'resubscribe' };
  }
  return { phase, action: null };
}
