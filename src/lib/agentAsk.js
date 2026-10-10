const ASK_ENTER = '\r';
const ASK_NEXT_TAB = '\x1b[C';

export function answerLabels(question, sel) {
  const labels = (sel?.indices ?? [])
    .map((i) => question.options[i]?.label ?? '')
    .filter((l) => l.length > 0);
  const other = (sel?.other ?? '').trim();
  return other ? [...labels, other] : labels;
}

export function formatAskAnswer(prompt, selections) {
  return prompt.questions
    .map((q, i) => answerLabels(q, selections[i]).join(', '))
    .join('\n');
}

export function buildAskAnswerKeys(prompt, selections, kind) {
  if (kind !== 'claude-digits') {
    return [];
  }

  const questions = prompt.questions;
  const multiQuestion = questions.length > 1;
  const groups = [];

  questions.forEach((q, qi) => {
    const sel = selections[qi];
    const other = (sel?.other ?? '').trim();
    const typeSomething = String(q.options.length + 1);

    if (q.multiSelect) {
      for (const i of sel?.indices ?? []) {
        groups.push({ raw: String(i + 1) });
      }
      if (other) {
        groups.push({ raw: typeSomething }, { text: other }, { raw: ASK_ENTER });
      }
      // Step to next tab
      groups.push({ raw: ASK_NEXT_TAB });
    } else if (other) {
      groups.push(
        { raw: typeSomething },
        { text: answerLabels(q, sel).join(', ') },
        { raw: ASK_ENTER }
      );
    } else if ((sel?.indices?.length ?? 0) > 0) {
      groups.push({ raw: String(sel.indices[0] + 1) });
    } else if (multiQuestion) {
      groups.push({ raw: ASK_NEXT_TAB });
    }
  });

  const endsOnSubmitTab =
    multiQuestion || (questions.length === 1 && questions[0].multiSelect === true);
  if (endsOnSubmitTab && groups.length > 0) {
    groups.push({ raw: ASK_ENTER });
  }
  return groups;
}
