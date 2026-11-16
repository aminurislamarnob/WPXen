import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  Info,
} from 'lucide-react';
import { Card, SectionLabel } from '../../ui';
import { GUIDES, findGuide } from '../../../lib/guides';
import { isItemVisible } from '../../../lib/settingsSearch';
import { useSettingsContext } from '../SettingsLayout';

// Settings → Help → Guides. `/settings/guides` lists every guide (filtered by
// the settings search); `/settings/guides/:guideId` reads one.
export default function GuidesSection() {
  const { guideId } = useParams();
  const { visible } = useSettingsContext();

  if (guideId) {
    const guide = findGuide(guideId);
    return guide ? <GuideReader guide={guide} /> : <GuideNotFound />;
  }

  const shown = GUIDES.filter((g) => isItemVisible(`guides.${g.id}`, visible));
  return (
    <div>
      <SectionLabel>Guides</SectionLabel>
      <Card>
        {shown.map((g) => (
          <Link
            key={g.id}
            to={`/settings/guides/${g.id}`}
            className="settings-row settings-row-btn group"
          >
            <BookOpen size={18} className="text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">{g.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{g.summary}</div>
            </div>
            <ArrowRight
              size={14}
              className="text-muted-foreground group-hover:text-foreground flex-shrink-0"
            />
          </Link>
        ))}
      </Card>
    </div>
  );
}

function GuideReader({ guide }) {
  const navigate = useNavigate();
  return (
    <article>
      <Link
        to="/settings/guides"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3"
      >
        <ArrowLeft size={12} />
        All guides
      </Link>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h1 className="text-[15px] font-semibold text-foreground">{guide.title}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{guide.summary}</p>
        </div>
        {guide.action && (
          <button
            onClick={() => navigate(guide.action.to, { state: guide.action.state })}
            className="btn-primary flex-shrink-0"
          >
            {guide.action.label}
          </button>
        )}
      </div>

      <Card className="divide-y divide-border">
        {guide.sections.map((section) => (
          <section key={section.heading} className="px-4 py-3 space-y-2">
            <h2 className="text-[12px] font-semibold text-foreground">
              {section.heading}
            </h2>
            {section.blocks.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </section>
        ))}
      </Card>
    </article>
  );
}

// `text` in backticks renders as code, so commands and paths stand out.
function Inline({ text }) {
  return String(text)
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      part.startsWith('`') && part.endsWith('`') ? (
        <code
          key={i}
          className="font-mono text-[12px] bg-muted px-1 py-px rounded text-foreground"
        >
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      )
    );
}

function Block({ block }) {
  switch (block.type) {
    case 'p':
      return (
        <p className="text-[12.5px] leading-normal text-muted-foreground">
          <Inline text={block.text} />
        </p>
      );
    case 'steps':
      return (
        <ol className="space-y-1">
          {block.items.map((item, i) => (
            <li
              key={i}
              className="flex gap-2 text-[12.5px] leading-normal text-foreground"
            >
              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-muted text-muted-foreground text-[10px] font-medium flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <span>
                <Inline text={item} />
              </span>
            </li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul className="space-y-1 list-disc pl-4 marker:text-muted-foreground">
          {block.items.map((item, i) => (
            <li key={i} className="text-[12.5px] leading-normal text-foreground">
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case 'note': {
      const warning = block.tone === 'warning';
      const Icon = warning ? AlertTriangle : Info;
      return (
        <div
          className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs leading-normal ${
            warning
              ? 'bg-status-warning/10 text-status-warning'
              : 'bg-highlight/10 text-highlight'
          }`}
        >
          <Icon size={12} className="flex-shrink-0 mt-0.5" />
          <span>
            <Inline text={block.text} />
          </span>
        </div>
      );
    }
    case 'table':
      return (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {block.head.map((h) => (
                  <th key={h} className="text-left font-medium px-2.5 py-1.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-border align-top">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-2.5 py-1.5 leading-normal ${j === 0 ? 'text-foreground w-[45%]' : 'text-muted-foreground'}`}
                    >
                      <Inline text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return <CodeBlock text={block.text} />;
    default:
      return null;
  }
}

function GuideNotFound() {
  return (
    <div>
      <SectionLabel>Guides</SectionLabel>
      <Card className="p-4 text-[13px] text-muted-foreground">
        That guide doesn’t exist.{' '}
        <Link to="/settings/guides" className="text-highlight hover:underline">
          See all guides
        </Link>
      </Card>
    </div>
  );
}

// A command to paste into Terminal. Copy goes through the clipboard API the
// renderer already has; nothing here runs the command.
function CodeBlock({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused: the command is still selectable text.
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5">
      <code className="flex-1 min-w-0 font-mono text-[11.5px] leading-normal text-foreground break-all select-text">
        {text}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy command"
        className="flex-shrink-0 text-muted-foreground hover:text-foreground mt-0.5"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}
