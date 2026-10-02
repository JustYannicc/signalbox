import { AssistantAvatar, generateAvatar } from "../assistant/avatar";
import { PersonAvatar } from "../multiplayer/PersonAvatar";
import type { TeamPerson } from "../multiplayer/multiplayerModel";
import { useAssistantDirectory } from "../multiplayer/personAssistant";
import type { CompanyAgent } from "./teamModel";
import { SectionHeading } from "./teamPrimitives";

/**
 * Who acts for whom: each person's own assistant represents them, and company
 * agents act for the team by asking those assistants, never reading people's data.
 */
export function AgentRepresentation({
  members,
  companyAgents,
}: {
  readonly members: readonly TeamPerson[];
  readonly companyAgents: readonly CompanyAgent[];
}) {
  const assistantOf = useAssistantDirectory();
  const byId = new Map(members.map((person) => [person.id, person]));
  return (
    <section aria-labelledby="team-agents" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionHeading
          id="team-agents"
          title="Company agents"
          note="They ask your assistant; it decides what to hand over"
        />
        <ul className="divide-y divide-border rounded-lg border border-border">
          {companyAgents.map((agent) => {
            const owner = byId.get(agent.ownerId);
            return (
              <li key={agent.id} className="flex items-center gap-3 px-3 py-2.5">
                <AssistantAvatar config={generateAvatar(agent.id)} size={28} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    May ask for: {agent.mayAsk}
                  </span>
                </div>
                {owner ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <PersonAvatar person={owner} size="xs" />
                    Owned by {owner.name.split(" ")[0]}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeading
          id="team-assistants"
          title="Personal assistants"
          note="Each one acts only for its owner"
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
