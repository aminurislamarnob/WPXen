import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import DiffView from '../DiffView';
import { ChatMarkdown } from './ChatMarkdown';
import { QuestionCard } from './QuestionCard';
import { SubagentRow } from './SubagentRow';
import { ImageRef } from './ImageRef';
import { buildAskAnswerKeys } from '../../lib/agentAsk';
import {
  reasoningLabel,
  runNeedsAttention,
  toolLabel,
  toolTarget,
} from '../../lib/chatRows';

// The chat's row renderers, shared by the main list and a subagent's nested
// rows so both show the same thing. `ctx` carries what a row needs from its
// Session: { sessionId, ask, tasks, nested, onLink, onFetchFull }.

export function ImageList({ sessionId, images }) {
  if (!images?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((ref) => (
        <ImageRef
          key={`${ref.uuid}-${ref.path.join('.')}`}
          sessionId={sessionId}
          refData={ref}
        />
      ))}
    </div>
  );
}

function Disclosure({ open, onToggle, children, className = '' }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full min-w-0 items-center gap-1.5 text-left ${className}`}
    >
      <ChevronRight
        size={13}
        className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
      />
      {children}
    </button>
  );
}

function TaskChip({ task }) {
  if (!task) return null;
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
        task.status === 'running'
          ? 'bg-highlight/15 text-highlight'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {task.status}
    </span>
  );
}

function ResultText({ result, onFetchFull }) {
  if (!result) {
    return <div className="text-[12px] italic text-muted-foreground">No result yet</div>;
  }
  return (
    <div>
      {result.content ? (
        <pre
          className={`m-0 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] ${
            result.is_error ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          {result.content}
        </pre>
      ) : (
        <div className="text-[12px] italic text-muted-foreground">Empty result</div>
      )}
      {result.truncated && onFetchFull && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {result.fullBytes
            ? `Showing the first part of ${Math.ceil(result.fullBytes / 1024)} KB.`
            : 'Output truncated.'}{' '}
          <button
            type="button"
            onClick={onFetchFull}
            className="underline hover:text-foreground"
          >
            Show full output
          </button>
        </div>
      )}
    </div>
  );
}

// One call in a tool run: its name and target, and — expanded — its result,
// or the inline diff for a file edit. The diff's CodeMirror mounts only while
// open: a run of edits would otherwise build an editor per call.
export function ToolItem({ item, ctx }) {
  const [open, setOpen] = useState(false);
  const { sessionId } = ctx;

  if (item.orphan) {
    const block = item.blocks?.[0];
    return (
      <div>
        <div className="mb-1 text-[12px] text-muted-foreground">
          Result for an earlier call
        </div>
        <ResultText
          result={block}
          onFetchFull={
            ctx.onFetchFull && block?.truncated
              ? () => ctx.onFetchFull(item.id, block.tool_use_id)
              : null
          }
        />
      </div>
    );
  }

  if (item.subagent) {
    return (
      <SubagentRow
        item={item}
        nestedMessages={ctx.nested?.[item.tool_use?.id]}
        ctx={ctx}
      />
    );
  }

  const name = item.tool_use?.name;
  if (name === 'AskUserQuestion' && ctx.ask && item.tool_use?.input?.questions) {
    return (
      <QuestionCard
        sessionId={sessionId}
        toolUseId={item.tool_use.id}
        prompt={item.tool_use.input}
        recorded={item.result?.answers}
        onSubmit={(selections) =>
          window.electronAPI.chatAnswer(
            sessionId,
            buildAskAnswerKeys(item.tool_use.input, selections, ctx.ask)
          )
        }
      />
    );
  }

  const target = item.edit?.path || toolTarget(item.tool_use);
  const task = item.taskId ? ctx.tasks?.[item.taskId] : null;
  const failed = !!(item.result?.is_error || item.result?.isError);
  return (
    <div>
      <Disclosure open={open} onToggle={() => setOpen((v) => !v)}>
        <span className="shrink-0 font-medium text-foreground">{toolLabel(name)}</span>
        {target && (
          <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {target}
          </code>
        )}
        <span className="flex-1" />
        <TaskChip task={task} />
        {failed && <span className="shrink-0 text-[11px] text-destructive">failed</span>}
        {!item.result && !task && (
          <span className="shrink-0 text-[11px] text-muted-foreground">running</span>
        )}
      </Disclosure>
      {open && (
        <div className="mt-2 pl-5">
          {item.edit ? (
            <DiffView
              name={item.edit.path}
              original={item.edit.original}
              modified={item.edit.modified}
            />
          ) : (
            <ResultText
              result={item.result}
              onFetchFull={
                ctx.onFetchFull && item.result?.truncated
                  ? () => ctx.onFetchFull(item.id, item.tool_use?.id)
                  : null
              }
            />
          )}
          <ImageList sessionId={sessionId} images={item.result?.images} />
        </div>
      )}
    </div>
  );
}

// Consecutive tool calls under one summary ("Read 3 files, ran 2 commands").
// It opens on its own while it holds a question card (answered or not) or a
// running subagent, so those never hide behind the summary.
export function ToolRun({ run, ctx }) {
  const live = runNeedsAttention(run);
  const [openState, setOpen] = useState(null);
  const open = openState ?? live;
  return (
    <div className="text-[13px]">
      <Disclosure open={open} onToggle={() => setOpen(!open)} className="font-medium">
        <span className="truncate">{run.summary}</span>
        {!run.success && (
          <span className="shrink-0 text-[11px] font-normal text-destructive">
            with errors
          </span>
        )}
      </Disclosure>
      {open && (
        <div className="mt-2 flex flex-col gap-2 border-l border-border pl-3">
          {run.items.map((item) => (
            <div key={item.id} className="text-[12px]">
              {item.role === 'reasoning' ? (
                <ReasoningRow row={item} onLink={ctx.onLink} />
              ) : (
                <ToolItem item={item} ctx={ctx} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReasoningRow({ row, onLink }) {
  const [open, setOpen] = useState(false);
  const label = reasoningLabel(row);
  if (!row.content) {
    return <div className="text-[12px] text-muted-foreground">{label}</div>;
  }
  return (
    <div>
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        className="text-[12px] text-muted-foreground"
      >
        {label}
      </Disclosure>
      {open && (
        <div className="mt-1 border-l border-border pl-3 text-[13px] italic text-muted-foreground">
          <ChatMarkdown text={row.content} empty="" onLink={onLink} />
        </div>
      )}
    </div>
  );
}

// One display item — a folded tool run or a single row — in its bubble. The
// user's bubble is a highlight tint, not `primary`: markdown renders in the
// foreground colour, which a monochrome primary fill would swallow.
export function ChatItem({ msg, ctx }) {
  if (msg.role === 'status') {
    return (
      <div
        className={`w-full text-center text-[12px] ${
          msg.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
        }`}
      >
        {msg.content}
      </div>
    );
  }
  const mine = msg.role === 'user' && !msg.orphan;
  let body;
  if (msg.role === 'tool-run') body = <ToolRun run={msg} ctx={ctx} />;
  else if (msg.role === 'reasoning')
    body = <ReasoningRow row={msg} onLink={ctx.onLink} />;
  else if (msg.role === 'assistant')
    body = (
      <div className="text-[13px] break-words">
        <ChatMarkdown text={msg.content} empty="" onLink={ctx.onLink} />
      </div>
    );
  else
    body = (
      <div className="text-[13px] break-words">
        {msg.content && <ChatMarkdown text={msg.content} empty="" onLink={ctx.onLink} />}
        <ImageList sessionId={ctx.sessionId} images={msg.images} />
      </div>
    );
  return (
    <div className={`flex w-full flex-col ${mine ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 ${
          mine ? 'bg-highlight/15' : 'bg-muted'
        }`}
      >
        {body}
      </div>
    </div>
  );
}
