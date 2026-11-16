import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, BookOpen, Info } from 'lucide-react';
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
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-[17px] font-semibold text-foreground">{guide.title}</h1>
          <p className="text-[13px] text-muted-foreground mt-1">{guide.summary}</p>
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

      <div className="space-y-5">
        {guide.sections.map((section) => (
          <section key={section.heading}>
            <SectionLabel>{section.heading}</SectionLabel>
            <Card className="p-4 space-y-3">
              {section.blocks.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </Card>
          </section>
        ))}
      </div>
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
        <p className="text-[13px] leading-relaxed text-foreground">
          <Inline text={block.text} />
        </p>
      );
    case 'steps':
      return (
        <ol className="space-y-2">
          {block.items.map((item, i) => (
            <li
              key={i}
              className="flex gap-3 text-[13px] leading-relaxed text-foreground"
            >
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted text-muted-foreground text-[11px] font-medium flex items-center justify-center mt-px">
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
        <ul className="space-y-1.5 list-disc pl-5 marker:text-muted-foreground">
          {block.items.map((item, i) => (
            <li key={i} className="text-[13px] leading-relaxed text-foreground">
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
          className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed ${
            warning
              ? 'bg-status-warning/10 text-status-warning'
              : 'bg-highlight/10 text-highlight'
          }`}
        >
          <Icon size={13} className="flex-shrink-0 mt-0.5" />
          <span>
            <Inline text={block.text} />
          </span>
        </div>
      );
    }
    case 'table':
      return (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {block.head.map((h) => (
                  <th key={h} className="text-left font-medium px-3 py-2">
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
                      className={`px-3 py-2 leading-relaxed ${j === 0 ? 'text-foreground font-medium w-[45%]' : 'text-muted-foreground'}`}
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
