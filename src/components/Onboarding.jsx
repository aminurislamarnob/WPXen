import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Beaker,
  Terminal,
  Copy,
  Check,
  RefreshCw,
  Globe,
  Play,
  PartyPopper,
  AlertCircle,
  Loader,
  Download,
  CheckCircle,
  Circle,
} from 'lucide-react';
import { Button, IconTile, ProgressLog, StepIndicator, Tooltip } from './ui';
import logo from '../assets/logo.svg';

const CORE_KEYS = ['nginx', 'php', 'mysql', 'dnsmasq', 'wpCli'];
const CORE_LABELS = {
  nginx: 'nginx',
  php: 'PHP',
  mysql: 'MySQL',
  dnsmasq: 'dnsmasq',
  wpCli: 'WP-CLI',
};

const coreInstalled = (d) => !!d && CORE_KEYS.every((k) => d[k]);

// Centered title + description block (icon supplied separately for Welcome).
function StepHeading({ title, children }) {
  return (
    <>
      <h1 className="text-[19px] font-bold text-foreground tracking-[-0.01em]">
        {title}
      </h1>
      {children && (
        <p className="text-[13px] leading-relaxed text-muted-foreground mt-2 mb-6 max-w-[320px] mx-auto">
          {children}
        </p>
      )}
    </>
  );
}

// Centered hero for a step: glossy icon tile above a heading + description.
// Wrapping IconTile (a block-level flex element) in a centered flex is what
// keeps the tile aligned with the centered text below it.
function StepHero({ icon, color, title, children }) {
  return (
    <>
      <div className="flex justify-center mb-4">
        <IconTile icon={icon} color={color} size={54} />
      </div>
      <StepHeading title={title}>{children}</StepHeading>
    </>
  );
}

// Builds the ordered step list, tailored to what's actually missing so a user
// who already has Homebrew / some services doesn't see dead steps. Welcome,
// DNS, Start and Done are always present.
function buildSteps(deps) {
  const steps = [{ id: 'welcome', label: 'Welcome' }];
  if (!deps?.brew) steps.push({ id: 'homebrew', label: 'Homebrew' });
  if (!coreInstalled(deps)) steps.push({ id: 'services', label: 'Services' });
  steps.push({ id: 'dns', label: 'DNS' });
  steps.push({ id: 'start', label: 'Start' });
  steps.push({ id: 'done', label: 'Done' });
  return steps;
}

export default function Onboarding({ deps, onComplete, onCreateFirstSite }) {
  const [depState, setDepState] = useState(deps);
  const [stepIdx, setStepIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [brewLaunched, setBrewLaunched] = useState(false);
  const [brewCmd, setBrewCmd] = useState('');

  // The step list is fixed for the life of the wizard (computed from the deps
  // at mount), so the indicator stays stable while installs flip deps to green.
  const steps = useMemo(() => buildSteps(deps), [deps]);
  const current = steps[stepIdx]?.id;
  const currentRef = useRef(current);
  currentRef.current = current;

  const next = () => {
    setError(null);
    setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  };

  // Live progress + dependency updates. `dependencies-update` also fires when
  // the user returns from the Homebrew Terminal (focus re-check), which is how
  // that step auto-advances.
  useEffect(() => {
    const onLine = ({ line }) => line && setLog((l) => [...l, line]);
    const onDeps = (d) => {
      setDepState(d);
      // Auto-advance install-driven steps once satisfied.
      if (currentRef.current === 'homebrew' && d.brew) next();
      else if (currentRef.current === 'services' && coreInstalled(d)) next();
    };
    window.electronAPI.on('core-deps-install-progress', onLine);
    window.electronAPI.on('dependencies-update', onDeps);
    return () => {
      window.electronAPI.off('core-deps-install-progress');
      window.electronAPI.off('dependencies-update');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async () => {
    const d = await window.electronAPI.checkDependencies();
    setDepState(d);
    return d;
  };

  async function handleInstallBrew() {
    setError(null);
    const res = await window.electronAPI.openHomebrewInstaller();
    if (res?.command) setBrewCmd(res.command);
    if (res?.success === false) setError(res.error || 'Could not open Terminal.');
    setBrewLaunched(true);
  }

  async function handleCopyCmd() {
    try {
      await navigator.clipboard.writeText(brewCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function handleInstallServices() {
    setError(null);
    setBusy(true);
    setLog(['Installing core services…']);
    try {
      const res = await window.electronAPI.installCoreDeps();
      if (res?.success === false) {
        setError(res.error || 'Install failed.');
      }
      // On success the `dependencies-update` event advances the step — don't
      // also advance here or the following (DNS) step gets skipped.
    } finally {
      setBusy(false);
    }
  }

  async function handleDns() {
    setError(null);
    setBusy(true);
    try {
      const res = await window.electronAPI.setupDnsmasq();
      if (res?.success === false) setError(res.error || 'DNS setup failed.');
      else next();
    } finally {
      setBusy(false);
    }
  }

  async function handleStartServices() {
    setError(null);
    setBusy(true);
    try {
      await window.electronAPI.startServices();
      next();
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish() {
    await window.electronAPI.setOnboardingComplete();
    onComplete();
  }

  async function handleCreateSite() {
    await window.electronAPI.setOnboardingComplete();
    onComplete();
    onCreateFirstSite?.();
  }

  return (
    <div className="h-screen flex items-center justify-center px-6 animate-fade-in">
      <div className="w-full max-w-[420px] settings-card px-8 pt-7 pb-8">
        <StepIndicator
          current={stepIdx}
          steps={steps.map((s) => s.label)}
          className="justify-center"
        />

        {error && (
          <div className="flex items-start gap-2 bg-destructive/10 text-destructive rounded-xl px-3.5 py-2.5 mb-4 text-xs text-left">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {current === 'welcome' && (
          <div className="text-center">
            <img
              src={logo}
              alt="WPDevPilot"
              className="h-9 w-auto mx-auto mb-5"
              draggable={false}
            />
            <StepHeading title="Welcome to WPDevPilot">
              Let&apos;s get your Mac set up for local WordPress development — WPDevPilot
              installs and configures everything it needs via Homebrew.
            </StepHeading>
            <div className="grid grid-cols-2 gap-2 mb-6 text-left">
              {['Homebrew', 'nginx', 'PHP', 'MySQL', 'dnsmasq', 'WP-CLI'].map((s) => (
                <div
                  key={s}
                  className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2 text-[12px] font-medium text-foreground"
                >
                  <Download size={12} className="text-muted-foreground flex-shrink-0" />
                  {s}
                </div>
              ))}
            </div>
            <Button variant="primary" className="w-full justify-center" onClick={next}>
              Get Started
            </Button>
          </div>
        )}

        {current === 'homebrew' && (
          <div className="text-center">
            <StepHero icon={Beaker} color="orange" title="Install Homebrew">
              Homebrew is the package manager WPDevPilot uses. It installs in Terminal —
              you may be asked for your password and to install Xcode tools.
            </StepHero>

            {!brewLaunched ? (
              <Button
                variant="primary"
                className="w-full justify-center"
                onClick={handleInstallBrew}
              >
                <Terminal size={12} strokeWidth={2.5} />
                Open Terminal &amp; Install
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
                  <Loader size={13} className="animate-spin" />
                  Waiting for Homebrew to finish installing…
                </div>
                {brewCmd && (
                  <div className="flex items-center gap-2 bg-tertiary border border-border rounded-md pl-3.5 pr-2 py-2">
                    <code className="text-[11px] text-foreground font-mono truncate flex-1 text-left">
                      {brewCmd}
                    </code>
                    <Tooltip label={copied ? 'Copied' : 'Copy command'}>
                      <button
                        onClick={handleCopyCmd}
                        aria-label="Copy command"
                        className="text-muted-foreground hover:text-foreground flex-shrink-0 p-1"
                      >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </Tooltip>
                  </div>
                )}
                <Button
                  variant="secondary"
                  className="w-full justify-center"
                  onClick={recheck}
                >
                  <RefreshCw size={12} strokeWidth={2.5} />
                  Re-check
                </Button>
              </div>
            )}
          </div>
        )}

        {current === 'services' && (
          <div className="text-center">
            <StepHero icon={Download} color="blue" title="Install core services">
              Installing nginx, PHP, MySQL, dnsmasq and WP-CLI via Homebrew. This can take
              a few minutes.
            </StepHero>

            <div className="bg-muted rounded-xl p-2 mb-4 divide-y divide-border">
              {CORE_KEYS.map((k) => (
                <div
                  key={k}
                  className="flex items-center gap-2.5 px-2 py-2 text-[13px] font-medium text-foreground"
                >
                  {depState?.[k] ? (
                    <CheckCircle
                      size={15}
                      className="text-status-running flex-shrink-0"
                    />
                  ) : busy ? (
                    <Loader
                      size={14}
                      className="text-muted-foreground animate-spin flex-shrink-0"
                    />
                  ) : (
                    <Circle
                      size={14}
                      className="text-muted-foreground/50 flex-shrink-0"
                    />
                  )}
                  {CORE_LABELS[k]}
                  {depState?.[k] && (
                    <span className="ml-auto text-[11px] text-status-running font-medium">
                      Ready
                    </span>
                  )}
                </div>
              ))}
            </div>

            {busy && <ProgressLog messages={log} className="mb-4" />}

            {coreInstalled(depState) ? (
              <Button variant="primary" className="w-full justify-center" onClick={next}>
                Continue
              </Button>
            ) : (
              <Button
                variant="primary"
                className="w-full justify-center"
                onClick={handleInstallServices}
                disabled={busy}
              >
                {busy ? (
                  <>
                    <Loader size={12} className="animate-spin" />
                    Installing…
                  </>
                ) : error ? (
                  'Retry install'
                ) : (
                  'Install services'
                )}
              </Button>
            )}
          </div>
        )}

        {current === 'dns' && (
          <div className="text-center">
            <StepHero icon={Globe} color="teal" title="Configure .test domains">
              WPDevPilot routes <code className="font-mono text-[12px]">*.test</code>{' '}
              sites to your Mac using dnsmasq. This needs your admin password once.
            </StepHero>
            <Button
              variant="primary"
              className="w-full justify-center"
              onClick={handleDns}
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader size={12} className="animate-spin" />
                  Configuring…
                </>
              ) : (
                'Configure DNS'
              )}
            </Button>
            <button
              onClick={next}
              className="block mx-auto text-xs text-muted-foreground hover:text-muted-foreground mt-3.5"
            >
              Skip for now
            </button>
          </div>
        )}

        {current === 'start' && (
          <div className="text-center">
            <StepHero icon={Play} color="green" title="Start services">
              Bring up nginx, PHP-FPM and MySQL so your sites can run.
            </StepHero>
            <Button
              variant="primary"
              className="w-full justify-center"
              onClick={handleStartServices}
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader size={12} className="animate-spin" />
                  Starting…
                </>
              ) : (
                'Start services'
              )}
            </Button>
          </div>
        )}

        {current === 'done' && (
          <div className="text-center">
            <StepHero icon={PartyPopper} color="purple" title="You're all set!">
              WPDevPilot is ready. Create your first WordPress site or head to the
              dashboard.
            </StepHero>
            <div className="space-y-2">
              <Button
                variant="primary"
                className="w-full justify-center"
                onClick={handleCreateSite}
              >
                Create your first site
              </Button>
              <Button
                variant="secondary"
                className="w-full justify-center"
                onClick={handleFinish}
              >
                Finish
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
