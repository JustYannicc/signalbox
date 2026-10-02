/**
 * Who `@` can reach from a composer. Chats and tasks: teammates, your
 * assistant, and your own agents for the container (section, project).
 * Teammates' assistants are reached through rooms, not here. Rooms: only the
 * other owner. The real chat composer merges these into its file menu.
 */
import { useMemo } from "react";

import { resolveAgent } from "../assistant/agentFixtures";
import { AssistantAvatar, generateAvatar } from "../assistant/avatar";
import type { ComposerMentionItem, ComposerMentionSource } from "../chat/useComposerMentionMenu";
import { containerAgentId, containerSectionId } from "./containerScope";
import { MentionPill } from "./MentionPill";
import { personHandle, resolveMention, splitHandle } from "./mentions";
import { TEAM_PEOPLE } from "./multiplayerFixtures";
import { useAssistantDirectory } from "./personAssistant";
import { PersonAvatar } from "./PersonAvatar";
import { currentPerson } from "./teamThreads";
import { sectionAgentId } from "../sidebar/sections/sectionModel";

const MAX_MATCHES = 8;

function agentsFor(containerId: string | null): readonly { id: string; name: string }[] {
  if (!containerId) return [];
  const ids = new Set<string>();
  const own = containerAgentId(containerId);
  if (own) ids.add(own);
  const sectionId = containerSectionId(containerId);
  if (sectionId) ids.add(sectionAgentId(sectionId));
  return [...ids].map((id) => ({ id, name: `${resolveAgent(id).name} agent` }));
}

export function useMentionDirectory(input: {
  /** Container whose agents are yours to mention; `null` for none. */
  containerId: string | null;
  /** Only these people (rooms: the owners). Default: every teammate. */
  peopleIds?: readonly string[];
  /** Your assistant and agents; off in rooms. */
  includeAgents: boolean;
  /** Marks teammates who can't see the item yet. */
  hasAccess?: (personId: string) => boolean;
}) {
  const resolveAssistant = useAssistantDirectory();
  const own = resolveAssistant(currentPerson);
  const { containerId, includeAgents, hasAccess } = input;
  const peopleKey = input.peopleIds?.join(",") ?? null;

  return useMemo(() => {
    const allowed = peopleKey === null ? null : new Set(peopleKey.split(","));
    const people: ComposerMentionItem[] = TEAM_PEOPLE.filter(
      (person) => person.id !== currentPerson.id && (allowed === null || allowed.has(person.id)),
    ).map((person) => ({
      id: `person:${person.id}`,
      type: "person",
      handle: personHandle(person),
      leading: <PersonAvatar person={person} size="sm" />,
      label: person.name,
      description:
        hasAccess && !hasAccess(person.id) ? `${person.title} · no access yet` : person.title,
    }));
    const agents: ComposerMentionItem[] = includeAgents
      ? [
          {
            id: "assistant:own",
            type: "person",
            handle: own.name,
            leading: <AssistantAvatar config={own.config} size={24} />,
            label: own.name,
            description: "Your assistant",
          },
          ...agentsFor(containerId).map((agent) => ({
            id: `agent:${agent.id}`,
            type: "person" as const,
            handle: agent.name,
            leading: <AssistantAvatar config={generateAvatar(agent.id)} size={24} />,
            label: agent.name,
            description: "Your agent",
          })),
        ]
      : [];
    const everyone = [...people, ...agents];
    const source: ComposerMentionSource = {
      items: (query) => {
        const needle = query.toLowerCase();
        return everyone
          .filter(
            (item) =>
              item.label.toLowerCase().includes(needle) ||
              item.handle.toLowerCase().startsWith(needle),
          )
          .slice(0, MAX_MATCHES);
      },
      renderMention: (value) => {
        const { handle, trailing } = splitHandle(value);
        const target = resolveMention(handle, own.name);
        if (!target) return null;
        if (target.kind === "person" && allowed !== null && !allowed.has(target.person.id)) {
          return null;
        }
        return (
          <>
            <MentionPill target={target} />
            {trailing}
          </>
        );
      },
      emptyStateText: includeAgents ? "No people or agents match." : "Nobody matches.",
    };
    return { source, ownAssistantName: own.name };
  }, [containerId, hasAccess, includeAgents, own.config, own.name, peopleKey]);
}
