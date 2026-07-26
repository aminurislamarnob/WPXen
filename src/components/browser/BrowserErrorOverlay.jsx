import { CloudOff, RotateCw } from 'lucide-react';

// Chromium's error codes are not something to put in front of a user, but the
// two they'll actually hit locally are worth naming: a stopped service, and a
// domain dnsmasq isn't resolving yet.
const HINTS = {
  '-105': 'That domain did not resolve. Check DNS & HTTPS in Settings.',
  '-106': 'No network connection.',
  '-102': 'Nothing is listening there — the site’s services may be stopped.',
  '-501': 'The certificate was rejected. Re-run the HTTPS setup for this site.',
  '-201': 'The certificate was rejected. Re-run the HTTPS setup for this site.',
};

export default function BrowserErrorOverlay({ error, onRetry }) {
  const hint = HINTS[String(error.code)];

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-8">
      <CloudOff size={36} className="text-muted-foreground/40" strokeWidth={1.5} />
      <div className="text-center max-w-sm">
        <p className="text-[13px] font-medium text-foreground">Can’t load this page</p>
        <p className="mt-1 text-[12px] text-muted-foreground select-text cursor-text">
          {hint || error.description || 'The page failed to load.'}
        </p>
        {error.url && (
          <p className="mt-1 text-[11px] text-muted-foreground/60 truncate select-text cursor-text">
            {error.url}
          </p>
        )}
      </div>
      <button className="btn btn-secondary" onClick={onRetry}>
        <RotateCw size={13} />
        Try Again
      </button>
    </div>
  );
}
