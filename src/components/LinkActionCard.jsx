import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, ExternalLink, Globe, Settings } from 'lucide-react';
import { Kbd, Tooltip } from './ui';
import { DESTINATION_LABEL, linkDestinations } from '../lib/terminal/linkActions';

// The card a plain click on a terminal URL opens, after Orca's
// LinkActionPopover: the URL with Copy and Settings, then the two places it
// can open — the default from Settings → Open links in (⌘-click) and the
// other one (⇧⌘-click). Anchored above the pointer; Escape, an outside click
// or picking a row closes it and hands focus back to the terminal.

const GAP = 6;
const MARGIN = 8;

const ICON = { system: ExternalLink, app: Globe };

function Row({ destination, alternate, onRun }) {
  const Icon = ICON[destination];
  return (
    <button
      type="button"
      onClick={onRun}
      className="flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] text-foreground hover:bg-accent"
    >
      <Icon size={14} className="flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{DESTINATION_LABEL[destination]}</span>
      <span className="flex items-center gap-1">
        {alternate && <Kbd tone="solid">⇧</Kbd>}
        <Kbd tone="solid">⌘</Kbd>
        <Kbd tone="solid">Click</Kbd>
      </span>
    </button>
  );
}

// `request` = { url, x, y } in viewport coordinates; `onOpen(url, dest)`.
export default function LinkActionCard({ request, openLinksIn, onOpen, onClose }) {
  const navigate = useNavigate();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [copied, setCopied] = useState(false);
  const { primary, alternate } = linkDestinations(openLinksIn);

  // Above the pointer, as Orca places it; below when there's no room, and
  // always inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let top = request.y - height - GAP;
    if (top < MARGIN) top = request.y + GAP + 12;
    const left = Math.max(
      MARGIN,
      Math.min(request.x, window.innerWidth - width - MARGIN)
    );
    setPos({ top: Math.min(top, window.innerHeight - height - MARGIN), left });
  }, [request]);

  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const run = (destination) => {
    onClose();
    onOpen(request.url, destination);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(request.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the link is on screen to select
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Open link"
      className="panel-menu fixed z-[70] w-max min-w-52 max-w-[min(21rem,calc(100vw-1rem))] p-1 animate-fade-in"
      // Measured before it's shown, so it never flashes at the wrong spot.
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
    >
      <div className="mb-0.5 flex items-center gap-1 border-b border-border px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">
        <span className="line-clamp-2 min-w-0 flex-1 break-all" title={request.url}>
          {request.url}
        </span>
        <Tooltip label={copied ? 'Copied' : 'Copy link'}>
          <button
            type="button"
            aria-label={copied ? 'Copied' : 'Copy link'}
            onClick={copy}
            className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </Tooltip>
        <Tooltip label="Link settings">
          <button
            type="button"
            aria-label="Link settings"
            onClick={() => {
              onClose();
              navigate('/settings/general');
            }}
            className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
          >
            <Settings size={13} />
          </button>
        </Tooltip>
      </div>
      <Row destination={primary} onRun={() => run(primary)} />
      <Row destination={alternate} alternate onRun={() => run(alternate)} />
    </div>,
    document.body
  );
}
