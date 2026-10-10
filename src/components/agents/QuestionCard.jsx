import { useState } from 'react';
import { Button } from '../ui';

export function QuestionCard({ prompt, result, onSubmit }) {
  // result is the `toolUseResult.answers` from the transcript if it's already answered.
  // prompt is the AskUserQuestion input.

  const [selections, setSelections] = useState(
    prompt.questions.map(() => ({ indices: [], other: '' }))
  );
  const [otherActive, setOtherActive] = useState(prompt.questions.map(() => false));

  const isAnswered = !!result;
  const questions = prompt.questions || [];

  const handleToggle = (qIndex, oIndex, multi) => {
    if (isAnswered) return;
    setSelections((prev) => {
      const next = [...prev];
      const sel = next[qIndex];
      if (multi) {
        if (sel.indices.includes(oIndex)) {
          sel.indices = sel.indices.filter((i) => i !== oIndex);
        } else {
          sel.indices = [...sel.indices, oIndex].sort((a, b) => a - b);
        }
      } else {
        sel.indices = [oIndex];
        sel.other = '';
        next[qIndex] = sel;
        // Auto-submit single select if it's the only question
        if (questions.length === 1 && !multi) {
          setTimeout(() => onSubmit(next), 0);
        }
      }
      return next;
    });
  };

  const handleOtherClick = (qIndex) => {
    if (isAnswered) return;
    setOtherActive((prev) => {
      const next = [...prev];
      next[qIndex] = true;
      return next;
    });
    setSelections((prev) => {
      const next = [...prev];
      if (!questions[qIndex].multiSelect) {
        next[qIndex].indices = [];
      }
      return next;
    });
  };

  const handleOtherChange = (qIndex, val) => {
    setSelections((prev) => {
      const next = [...prev];
      next[qIndex].other = val;
      return next;
    });
  };

  const handleOtherKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (questions.length === 1) {
        onSubmit(selections);
      }
    }
  };

  const handleSubmit = () => {
    if (!isAnswered) {
      onSubmit(selections);
    }
  };

  return (
    <div className="bg-elevation-2 rounded-md border border-elevation-3 overflow-hidden my-2">
      {questions.map((q, qi) => {
        // Find if transcript answers exist
        const recordedAnswer = result && result[q.question];

        return (
          <div key={qi} className="p-3 border-b border-elevation-3 last:border-b-0">
            {q.header && <div className="text-xs text-text-muted mb-1">{q.header}</div>}
            <div className="text-sm font-medium text-text-main mb-2">{q.question}</div>

            {isAnswered ? (
              <div className="text-sm text-text-muted bg-elevation-1 p-2 rounded">
                Answered:{' '}
                <span className="text-text-main">{recordedAnswer || 'None'}</span>
              </div>
            ) : (
              <div className="space-y-1">
                {q.options.map((opt, oi) => {
                  const isSelected = selections[qi].indices.includes(oi);
                  return (
                    <div
                      key={oi}
                      onClick={() => handleToggle(qi, oi, q.multiSelect)}
                      className={`px-3 py-2 text-sm rounded cursor-pointer border ${
                        isSelected
                          ? 'bg-primary-500/10 border-primary-500/50 text-primary-400'
                          : 'bg-elevation-1 border-transparent text-text-main hover:bg-elevation-3'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {q.multiSelect && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            readOnly
                            className="pointer-events-none"
                          />
                        )}
                        {!q.multiSelect && (
                          <div
                            className={`w-3 h-3 rounded-full border ${isSelected ? 'border-4 border-primary-500' : 'border-elevation-4'}`}
                          />
                        )}
                        <span>{opt.label}</span>
                        {opt.description && (
                          <span className="text-text-muted text-xs ml-1">
                            - {opt.description}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}

                <div
                  className={`px-3 py-2 text-sm rounded cursor-pointer border ${
                    otherActive[qi] || selections[qi].other
                      ? 'bg-primary-500/10 border-primary-500/50 text-primary-400'
                      : 'bg-elevation-1 border-transparent text-text-main hover:bg-elevation-3'
                  }`}
                  onClick={() => handleOtherClick(qi)}
                >
                  <div className="flex items-center gap-2">
                    {!q.multiSelect && (
                      <div
                        className={`w-3 h-3 rounded-full border ${otherActive[qi] || selections[qi].other ? 'border-4 border-primary-500' : 'border-elevation-4'}`}
                      />
                    )}
                    {otherActive[qi] ? (
                      <input
                        autoFocus
                        type="text"
                        value={selections[qi].other}
                        onChange={(e) => handleOtherChange(qi, e.target.value)}
                        onKeyDown={(e) => handleOtherKeyDown(e, qi)}
                        className="bg-transparent outline-none flex-1"
                        placeholder="Type your answer..."
                      />
                    ) : (
                      <span>Other...</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {!isAnswered && (questions.length > 1 || questions[0]?.multiSelect) && (
        <div className="p-3 bg-elevation-1 flex justify-end">
          <Button onClick={handleSubmit} variant="primary">
            Submit
          </Button>
        </div>
      )}
    </div>
  );
}
