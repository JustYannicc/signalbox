/**
 * The New bar's grammar for the assistant composer: `@` people and agents, `#`
 * projects, sections and chats. Suggestions come from the capture bar's own
 * `useCaptureSuggestions`, fed the query the composer's mention menu reports.
 */
import { FolderIcon, LayersIcon, MessageSquareIcon, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  TOKEN_KIND_LABELS,
  type CaptureToken,
  type CaptureTokenKind,
} from "../capture/captureTokens";
import { useCaptureSuggestions } from "../capture/useCaptureSuggestions";
import type {
  ComposerMentionItem,
  ComposerMentionSource,
  ComposerTagSource,
} from "../chat/useComposerMentionMenu";
import { MentionPill } from "../multiplayer/MentionPill";
import { personHandle, resolveMention, splitHandle } from "../multiplayer/mentions";
import { TEAM_PEOPLE } from "../multiplayer/multiplayerFixtures";
import { PersonAvatar } from "../multiplayer/PersonAvatar";
import { HOME_SECTIONS } from "../sidebar/sections/sectionModel";
import { SupervisorAvatar } from "./AssistantGlyphs";
import { AssistantIcon } from "./AssistantIcon";
import { useAssistantIdentity } from "./assistantIdentity";

const AVATAR_SIZE = 24;

const TAG_ICONS: Partial<Record<CaptureTokenKind, LucideIcon>> = {
  project: FolderIcon,
  section: LayersIcon,
  chat: MessageSquareIcon,
};

function tokenPerson(token: CaptureToken) {
  return TEAM_PEOPLE.find((candidate) => `person:${candidate.id}` === token.id) ?? null;
}

function tokenLeading(token: CaptureToken): ReactNode {
  const Icon = TAG_ICONS[token.kind];
  if (Icon) return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  const person = tokenPerson(token);
  if (person) return <PersonAvatar person={person} size="sm" />;
  if (token.id === "agent:assistant") return <AssistantIcon size={AVATAR_SIZE} />;
  const section = HOME_SECTIONS.find((candidate) => `agent:section:${candidate.id}` === token.id);
  return <SupervisorAvatar agentId={section?.agentId ?? token.id} size={AVATAR_SIZE} />;
}

/** The team chats' handle for people ("Flynn", "Flynn M"), so the pill resolves; agents by name. */
function mentionHandleFor(token: CaptureToken): string {
  const person = tokenPerson(token);
  return person ? personHandle(person) : token.label;
}

/** `#` has no quoted form, so "Merchant portal" tags as `#Merchant-portal`. */
function tagHandle(label: string): string {
  return label.trim().replace(/\s+/g, "-");
}

function toItem(token: CaptureToken, handle: string): ComposerMentionItem {
  return {
    id: token.id,
    type: "person",
    handle,
    leading: tokenLeading(token),
    label: token.label,
    description: TOKEN_KIND_LABELS[token.kind],
  };
}

export function useAssistantComposerSources(): {
  mentions: ComposerMentionSource;
  tags: ComposerTagSource;
} {
  const [atQuery, setAtQuery] = useState("");
  const [hashQuery, setHashQuery] = useState("");
  const atTokens = useCaptureSuggestions("@", atQuery);
  const hashTokens = useCaptureSuggestions("#", hashQuery);
  const assistantName = useAssistantIdentity().name;

  const mentions = useMemo<ComposerMentionSource>(() => {
    const items = atTokens.map((token) => toItem(token, mentionHandleFor(token)));
    return {
      items: () => items,
      onQueryChange: setAtQuery,
      emptyStateText: "No people or agents match.",
      renderMention: (value) => {
        const { handle, trailing } = splitHandle(value);
        const target = resolveMention(handle, assistantName);
        return target ? (
          <>
            <MentionPill target={target} />
            {trailing}
          </>
        ) : null;
      },
    };
  }, [assistantName, atTokens]);

  const tags = useMemo<ComposerTagSource>(() => {
    const items = hashTokens.map((token) => toItem(token, tagHandle(token.label)));
    return {
      items: () => items,
      onQueryChange: setHashQuery,
      emptyStateText: "No projects, sections or chats match.",
    };
  }, [hashTokens]);

  return { mentions, tags };
}
