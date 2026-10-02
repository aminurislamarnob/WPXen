import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Github, KeyRound, Loader2, LogIn } from 'lucide-react';
import { ghSetupCommand, hasScope, setupStep } from '../lib/tasks';
import { hasFloatingRunner, runInFloatingTerminal } from '../lib/floatingBus';

// Getting `gh` ready for Tasks: one-click install through Homebrew, and
// sign-in (or a missing scope) run as `gh auth …` in a Floating Workspace
// terminal — those flows are interactive, so they get a real terminal rather
// than a headless process. While one runs, the page polls preflight until the
// login lands, so finishing in the terminal is all the user has to do.

const POLL_MS = 4000;
const POLL_LIMIT_MS = 10 * 60_000;

// Runs `gh auth login` (or `gh auth refresh -s <scope>`) and waits for it.
// `phase`: idle | waiting | manual (no floating terminal — type it yourself).
export function useGhSignIn({ scope = null, onDone }) {
  const [phase, setPhase] = useState('idle');
  const command = ghSetupCommand(scope ? { scope } : {});
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    const started = Date.now();
    let cancelled = false;
    const id = setInterval(async () => {
      if (Date.now() - started > POLL_LIMIT_MS) {
        clearInterval(id);
        setPhase('idle');
        return;
      }
      const pre = await window.electronAPI.tasksPreflight();
      if (cancelled) return;
      if (pre?.authenticated && hasScope(pre, scope)) {
        clearInterval(id);
        setPhase('idle');
        onDoneRef.current?.(pre);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, scope]);

  const start = useCallback(async () => {
    if (!command) return;
    const sessionId = hasFloatingRunner()
      ? await runInFloatingTerminal({ command, cwd: '~' })
      : null;
    setPhase(sessionId ? 'waiting' : 'manual');
  }, [command]);

  return { phase, start, command };
}

function useGhInstall({ onDone }) {
  const [installing, setInstalling] = useState(false);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);

  useEffect(
    () =>
      window.electronAPI.on('tasks-gh-install-progress', ({ line }) =>
        setLines((prev) => [...prev, line].slice(-4))
      ),
    []
  );

  const install = async () => {
    setInstalling(true);
    setError(null);
    setLines([]);
    try {
      const res = await window.electronAPI.tasksInstallGh();
      if (res?.success) onDone?.(res.status);
      else setError(res?.error || 'Install failed');
    } finally {
      setInstalling(false);
    }
  };

  return { installing, lines, error, install };
}

function CommandHint({ command }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the command is on screen to select
    }
  };
  return (
    <div className="mt-3 mx-auto max-w-md flex items-center gap-2 rounded-md bg-tertiary px-3 py-2 text-left">
      <code className="flex-1 font-mono text-[12px] text-foreground select-text break-all">
        {command}
      </code>
      <button
        onClick={copy}
        aria-label="Copy command"
        className="text-muted-foreground hover:text-foreground"
      >
        <Copy size={13} />
      </button>
      {copied && <span className="text-[11px] text-muted-foreground">Copied</span>}
    </div>
  );
}

function Waiting({ children }) {
  return (
    <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
      <Loader2 size={13} className="animate-spin" />
      {children}
    </p>
  );
}

// The page-level banner while `gh` is missing or signed out.
export function SetupBanner({ preflight, onReady, onRetry }) {
  const step = setupStep(preflight);
  const signIn = useGhSignIn({ onDone: onReady });
  const setup = useGhInstall({
    onDone: (status) => (status?.authenticated ? onReady(status) : onRetry()),
  });

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-8 text-center">
      <Github size={28} className="mx-auto text-muted-foreground" />
      <p className="mt-3 text-[14px] font-medium text-foreground">
        {step === 'install' ? 'Install the GitHub CLI' : 'Sign in to GitHub'}
      </p>
      <p className="mt-1 text-[12.5px] text-muted-foreground max-w-md mx-auto">
        {step === 'install' ? (
          <>
            Tasks talks to GitHub through <code className="font-mono">gh</code>, so WPXen
            never stores a token. It installs with Homebrew.
          </>
        ) : (
          <>
            Sign-in runs <code className="font-mono">gh auth login</code> in a terminal:
            confirm the code in your browser, and this page picks it up.
          </>
        )}
      </p>
      {step === 'sign-in' &&
        preflight?.error?.message &&
        preflight.error.code !== 'not-authenticated' && (
          <p className="mt-1 text-[11.5px] text-muted-foreground/80">
            {preflight.error.message}
          </p>
        )}

      <div className="mt-4 flex items-center justify-center gap-2">
        {step === 'install' ? (
          <button
            className="btn btn-primary"
            onClick={setup.install}
            disabled={setup.installing}
          >
            {setup.installing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {setup.installing ? 'Installing…' : 'Install gh'}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={signIn.start}
            disabled={signIn.phase === 'waiting'}
          >
            <LogIn size={14} />
            Sign in
          </button>
        )}
        <button className="btn btn-secondary" onClick={onRetry}>
          Check again
        </button>
      </div>

      {setup.installing && setup.lines.length > 0 && (
        <div className="mt-3 mx-auto max-w-md rounded-md bg-tertiary px-3 py-2 text-left font-mono text-[11px] text-muted-foreground">
          {setup.lines.map((l, i) => (
            <div key={i} className="truncate">
              {l}
            </div>
          ))}
        </div>
      )}
      {setup.error && <p className="mt-3 text-[12px] text-destructive">{setup.error}</p>}
      {signIn.phase === 'waiting' && (
        <Waiting>Finish signing in in the terminal…</Waiting>
      )}
      {signIn.phase === 'manual' && (
        <>
          <p className="mt-3 text-[12px] text-muted-foreground">
            Run this in a terminal, then check again:
          </p>
          <CommandHint command={signIn.command} />
        </>
      )}
    </div>
  );
}

// Shown in place of a view that needs a scope the login lacks — Projects asks
// for `read:project`, which `gh auth login` doesn't grant by default.
export function GrantAccessBanner({ scope, reason, onGranted }) {
  const grant = useGhSignIn({ scope, onDone: onGranted });
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm px-6 py-8 text-center">
      <KeyRound size={26} className="mx-auto text-muted-foreground" />
      <p className="mt-3 text-[14px] font-medium text-foreground">
        GitHub needs the <code className="font-mono">{scope}</code> scope
      </p>
      {reason && (
        <p className="mt-1 text-[12.5px] text-muted-foreground max-w-md mx-auto">
          {reason}
        </p>
      )}
      <div className="mt-4 flex items-center justify-center gap-2">
        <button
          className="btn btn-primary"
          onClick={grant.start}
          disabled={grant.phase === 'waiting' || !grant.command}
        >
          <KeyRound size={14} />
          Grant access
        </button>
      </div>
      {grant.phase === 'waiting' && (
        <Waiting>Approve the new scope in the terminal…</Waiting>
      )}
      {grant.phase === 'manual' && grant.command && (
        <>
          <p className="mt-3 text-[12px] text-muted-foreground">
            Run this in a terminal, then reload:
          </p>
          <CommandHint command={grant.command} />
        </>
      )}
    </div>
  );
}
