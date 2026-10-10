import { useState } from 'react';
import { Button } from '../ui';
import { askAnswerStatus } from '../../lib/agentAsk';

// What each card sent, by `${sessionId}:${toolUseId}`. Module-level because
// the virtualised list unmounts cards scrolled out of view, and a remounted
// card must stay locked rather than offer to answer twice.
const sentAnswers = new Map();

const emptySelections = (questions) => questions.map(() => ({ indices: [], other: '' }));

// An AskUserQuestion call as a card. Choosing sends key steps to the TUI
// (onSubmit); once the transcript records the answer (`recorded`, the result's
// answers by question text) the card shows it, and flags a difference from
// what was sent.
export function QuestionCard({ sessionId, toolUseId, prompt, recorded, onSubmit }) {
  const questions = prompt.questions || [];
  const key = `${sessionId}:${toolUseId}`;
  const [selections, setSelections] = useState(() => emptySelections(questions));
  const [otherOpen, setOtherOpen] = useState(() => questions.map(() => false));
  const [sent, setSent] = useState(() => sentAnswers.get(key) || null);

  const status = askAnswerStatus(prompt, recorded, sent);
  const locked = !!status || !!sent;
  // One single-select question answers on click; anything else needs Submit.
  const instant = questions.length === 1 && !questions[0]?.multiSelect;

  const submit = (next) => {
    if (locked) return;
    sentAnswers.set(key, next);
    setSent(next);
    onSubmit(next);
  };

  const choose = (qi, oi) => {
    if (locked) return;
    const q = questions[qi];
    const prev = selections[qi];
    const indices = q.multiSelect
      ? prev.indices.includes(oi)
        ? prev.indices.filter((i) => i !== oi)
        : [...prev.indices, oi].sort((a, b) => a - b)
      : [oi];
    const next = selections.map((sel, i) =>
      i === qi ? { indices, other: q.multiSelect ? sel.other : '' } : sel
    );
    setSelections(next);
    if (instant) submit(next);
  };

  const openOther = (qi) => {
    if (locked) return;
    setOtherOpen((prev) => prev.map((open, i) => (i === qi ? true : open)));
    if (!questions[qi].multiSelect) {
      setSelections((prev) =>
        prev.map((sel, i) => (i === qi ? { ...sel, indices: [] } : sel))
      );
    }
  };

  const typeOther = (qi, other) =>
    setSelections((prev) => prev.map((sel, i) => (i === qi ? { ...sel, other } : sel)));

  const optionClass = (on) =>
    `w-full text-left px-3 py-2 text-[13px] rounded-md border transition-colors ${
      on
        ? 'bg-highlight/10 border-highlight/50 text-foreground'
        : 'bg-background border-border hover:bg-accent'
    }`;

  return (
    <div className="my-2 rounded-lg border border-border bg-card overflow-hidden">
      {questions.map((q, qi) => (
        <div key={qi} className="p-3 border-b border-border last:border-b-0">
          {q.header && (
            <div className="text-[11px] text-muted-foreground mb-1">{q.header}</div>
          )}
          <div className="text-[13px] font-medium mb-2">{q.question}</div>

          {status ? (
            <div className="text-[13px] rounded-md bg-muted px-2 py-1.5">
              <span className="text-muted-foreground">Answered: </span>
              {status[qi].answer || 'No answer'}
              {status[qi].mismatch && (
                <div className="mt-1 text-[12px] text-status-warning">
                  The card sent “{status[qi].sent}”, but the terminal recorded this
                  answer.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {q.options.map((opt, oi) => (
                <button
                  key={oi}
                  type="button"
                  disabled={locked}
                  onClick={() => choose(qi, oi)}
                  className={optionClass(selections[qi].indices.includes(oi))}
                >
                  <span>{opt.label}</span>
                  {opt.description && (
                    <span className="ml-1 text-[12px] text-muted-foreground">
                      — {opt.description}
                    </span>
                  )}
                </button>
              ))}
              {otherOpen[qi] ? (
                <input
                  autoFocus
                  type="text"
                  disabled={locked}
                  value={selections[qi].other}
                  onChange={(e) => typeOther(qi, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && instant && selections[qi].other.trim()) {
                      e.preventDefault();
                      submit(selections);
                    }
                  }}
                  className="form-input w-full"
                  placeholder="Type your answer…"
                />
              ) : (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => openOther(qi)}
                  className={optionClass(false)}
                >
                  Other…
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {!status && sent && (
        <div className="px-3 py-2 text-[12px] text-muted-foreground border-t border-border">
          Sent — waiting for the answer to be recorded.
        </div>
      )}
      {!locked && !instant && (
        <div className="p-3 flex justify-end border-t border-border">
          <Button variant="primary" onClick={() => submit(selections)}>
            Submit
          </Button>
        </div>
      )}
    </div>
  );
}
