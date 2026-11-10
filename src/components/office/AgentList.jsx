import { CornerDownRight } from 'lucide-react';
import { agentList } from '../../lib/office/hud.js';
import { teamColor } from '../../lib/office/scene/theme.js';
import { PanelHeader, TeamSwatch } from './PanelChrome.jsx';
import { StateBadge } from './StateBadge.jsx';

// The agent list beside the office: every session in the room grouped by
// project, waiting-on-you first (ordering in lib/office/hud.js). Clicking a
// row focuses that agent exactly as clicking its character does.

export function AgentList({ office, onSelect, onClose }) {
  const groups = agentList(office);
  return (
    <>
      <PanelHeader title="Agents" closeLabel="Hide agent list" onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No agents in this room.
          </p>
        )}
        {groups.map(({ projectKey, sessions }) => (
          <section key={projectKey} className="mt-2 first:mt-0">
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              <TeamSwatch color={teamColor(projectKey)} />
              <span className="truncate">{projectKey}</span>
              <span className="ml-auto tabular-nums font-normal">{sessions.length}</span>
            </div>
            <ul>
              {sessions.map(({ session, interns }) => (
                <li key={session.pid}>
                  <button
                    className="panel-item flex-wrap gap-y-0.5"
                    onClick={() => onSelect({ pid: session.pid })}
                  >
                    <span className="flex-1 min-w-0 truncate text-left font-medium">
                      {session.title || session.name}
                    </span>
                    <StateBadge
                      state={session.state}
                      tool={session.currentTool}
                      onBreak={session.onBreak}
                      compact
                    />
                    {session.gitBranch && (
                      <span className="basis-full truncate text-left font-mono text-[11px] text-muted-foreground">
                        {session.gitBranch}
                      </span>
                    )}
                  </button>
                  {interns.map((sub) => (
                    <button
                      key={sub.subagentId}
                      className="panel-item pl-4"
                      onClick={() =>
                        onSelect({ pid: session.pid, subagentId: sub.subagentId })
                      }
                    >
                      <CornerDownRight
                        size={12}
                        className="text-muted-foreground flex-shrink-0"
                      />
                      <span className="flex-1 min-w-0 truncate text-left text-muted-foreground">
                        {sub.agentType}
                      </span>
                      <StateBadge state={sub.state} tool={sub.currentTool} compact />
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
