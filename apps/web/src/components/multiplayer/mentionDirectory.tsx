/**
 * Who `@` can reach from a composer. Chats and tasks: teammates, then the
 * agents on the container's level chain, nearest first (its own level's
 * agent, each one above, and your assistant at the top): who you'd ask from
 * there. Teammates' assistants are reached through rooms, not here. Rooms:
 * only the other owner. The real chat composer merges these into its file menu.
 */
import { useMemo } from "react";

import { AssistantAvatar, generateAvatar } from "../assistant/avatar";
import type { ComposerMentionItem, ComposerMentionSource } from "../chat/useComposerMentionMenu";
import { chainAgents } from "../levels/chainAgents";
import { useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { TOP_LEVEL } from "../levels/levels";
import { containerLevel } from "./containerScope";
import { MentionPill } from "./MentionPill";
import { personHandle, resolveMention, splitHandle } from "./mentions";
import { TEAM_PEOPLE } from "./multiplayerFixtures";
import { useAssistantDirectory } from "./personAssistant";
import { PersonAvatar } from "./PersonAvatar";
import { currentPerson } from "./teamThreads";

const MAX_MATCHES = 8;

export function useMentionDirectory(input: {
  /** Container whose level chain's agents to offer; `null` for just your assistant. */
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
  const levelOptions = useLevelOptionsContext();
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
    const level = containerId ? containerLevel(containerId) : TOP_LEVEL;
    const agents: ComposerMentionItem[] = includeAgents
      ? chainAgents(level, levelOptions).map((option) =>
          option.agentId === null || option.agentName === null
            ? {
                id: "assistant:own",
                type: "person",
                handle: own.name,
                leading: <AssistantAvatar config={own.config} size={24} />,
                label: own.name,
                description: "Your assistant · Top level",
              }
            : {
                id: `agent:${option.agentId}`,
                type: "person",
                handle: option.agentName,
                leading: <AssistantAvatar config={generateAvatar(option.agentId)} size={24} />,
                label: option.agentName,
                description: option.label,
              },
        )
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
  }, [containerId, hasAccess, includeAgents, levelOptions, own.config, own.name, peopleKey]);
}
