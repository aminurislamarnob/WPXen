import { Button } from '../ui';

// The TUI is asking for something the transcript can't show (folder trust,
// plan approval, sign-in, a permission prompt): what's on screen, and a way
// to answer it in the terminal.
export function WaitingFallback({ snapshot, onSwitch }) {
  return (
    <div className="my-2 rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-border flex justify-between items-center">
        <div className="text-[13px] font-medium flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-status-warning animate-pulse" />
          Waiting for input in the terminal
        </div>
        <Button onClick={onSwitch} variant="primary">
          Switch to terminal
        </Button>
      </div>
      {snapshot ? (
        <pre className="m-0 p-3 bg-tertiary text-[11px] text-muted-foreground font-mono whitespace-pre-wrap overflow-hidden">
          {snapshot}
        </pre>
      ) : null}
    </div>
  );
}
