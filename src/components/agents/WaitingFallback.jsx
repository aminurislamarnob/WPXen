import { Button } from '../ui';

export function WaitingFallback({ snapshot, onSwitch }) {
  return (
    <div className="bg-elevation-2 rounded-md border border-elevation-3 overflow-hidden my-2">
      <div className="p-3 border-b border-elevation-3 flex justify-between items-center">
        <div className="text-sm font-medium text-text-main flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-primary-500 animate-pulse" />
          Waiting for input in terminal
        </div>
        <Button onClick={onSwitch} variant="primary" size="sm">
          Switch to Terminal
        </Button>
      </div>
      {snapshot ? (
        <div className="p-3 bg-elevation-1">
          <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap overflow-hidden">
            {snapshot}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
