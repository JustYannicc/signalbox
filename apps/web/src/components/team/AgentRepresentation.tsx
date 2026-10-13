/**
 * Who acts for whom on the Team page. The team's agents are the agents of its
 * levels (the team section and its projects): shared with every member, each
 * coordinating the threads and automations at its level. Each person's own
 * assistant acts only for them. When a team agent needs something only a
 * person has (receipts, free/busy), it asks that person's assistant, which
 * lends it for the task or hands back only what's needed. Private chats and
 * tasks stay with their owner either way.
 */
import { Link } from "@tanstack/react-router";

import { SupervisorAvatar } from "../assistant/AssistantGlyphs";
import { AssistantAvatar } from "../assistant/avatar";
import { useLevelOptions } from "../levels/LevelOptionsProvider";
import { levelTeam } from "../levels/levelSharing";
import type { Team, TeamPerson } from "../multiplayer/multiplayerModel";
import { useAssistantDirectory } from "../multiplayer/personAssistant";
import { SectionHeading } from "./teamPrimitives";

export function AgentRepresentation({
  team,
  members,
}: {
  readonly team: Team;
  readonly members: readonly TeamPerson[];
}) {
  const assistantOf = useAssistantDirectory();
  const teamAgents = useLevelOptions().flatMap(({ agentId, ...option }) =>
    agentId !== null && levelTeam(option.key)?.id === team.id ? [{ ...option, agentId }] : [],
  );
  return (
    <section aria-labelledby="team-agents" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionHeading
          id="team-agents"
          title="Team agents"
          note="Shared with everyone here; private chats stay private"
        />
        <ul className="divide-y divide-border rounded-lg border border-border">
          {teamAgents.map((option) => (
            <li key={option.key}>
              <Link
                to="/agent/$agentId"
                params={{ agentId: option.agentId }}
                className="flex items-center gap-3 px-3 py-2.5 outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <SupervisorAvatar agentId={option.agentId} size={28} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {option.agentName}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    Coordinates the threads and automations in {option.label}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading
          id="team-assistants"
          title="Personal assistants"
          note="Team agents ask them; each decides what to hand over"
        />
        <ul className="grid gap-2 sm:grid-cols-2">
          {members.map((person) => {
            const assistant = assistantOf(person);
            return (
              <li
                key={person.id}
                className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"
              >
                <AssistantAvatar config={assistant.config} size={24} />
                <span className="min-w-0 truncate text-sm text-foreground">{assistant.name}</span>
                <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                  {assistant.isYours ? "Yours" : `For ${person.name.split(" ")[0]}`}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
