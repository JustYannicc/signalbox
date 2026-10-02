/**
 * @mentions. Mentions are the composer's own `@handle` tokens
 * (`collectComposerInlineTokens`); a handle names a teammate (first name, plus
 * last initial when two share it), your assistant, or one of your own agents
 * (`@"Northwind agent"`). Teammates' assistants are reached through rooms, never
 * mentioned in chats. A mention you're part of that nobody answered yet shows
 * as "Waiting on Samir" / "Needs you".
 */
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import { TEAM_PEOPLE } from "./multiplayerFixtures";
import { firstName, type TeamMessage, type TeamPerson } from "./multiplayerModel";
import { currentPerson, findPerson } from "./teamThreads";

export type MentionTarget =
  | { readonly kind: "person"; readonly person: TeamPerson }
  /** Your assistant. */
  | { readonly kind: "assistant"; readonly name: string }
  /** One of your agents, e.g. "Northwind agent". Agents are personal. */
  | { readonly kind: "agent"; readonly name: string };

const AGENT_HANDLE = /^(.+) agent$/i;

/** "Flynn", or "Flynn M" when another teammate is also called Flynn. */
export function personHandle(person: TeamPerson): string {
  const first = firstName(person.name);
  const clash = TEAM_PEOPLE.some(
    (other) =>
      other.id !== person.id && firstName(other.name).toLowerCase() === first.toLowerCase(),
  );
  const lastInitial = person.name.trim().split(/\s+/).at(-1)?.[0] ?? "";
  return clash && lastInitial ? `${first} ${lastInitial.toUpperCase()}` : first;
}

/** `ownAssistantName` is yours from settings; without it the fixture name is used. */
export function resolveMention(handle: string, ownAssistantName?: string): MentionTarget | null {
  const key = handle.trim().toLowerCase();
  const person = TEAM_PEOPLE.find(
    (candidate) =>
      candidate.id === key ||
      personHandle(candidate).toLowerCase() === key ||
      candidate.name.toLowerCase() === key,
  );
  if (person) return { kind: "person", person };
  const assistantName = ownAssistantName ?? currentPerson.assistantName;
  if (assistantName.toLowerCase() === key) return { kind: "assistant", name: assistantName };
  return AGENT_HANDLE.test(handle.trim()) ? { kind: "agent", name: handle.trim() } : null;
}

/** What the composer inserts after `@`. */
export function mentionHandle(target: MentionTarget): string {
  return target.kind === "person" ? personHandle(target.person) : target.name;
}

/** What the pill shows, Slack-style: the full name for people. */
export function mentionLabel(target: MentionTarget): string {
  return target.kind === "person" ? target.person.name : target.name;
}

/** `@Flynn,` tokenizes as `Flynn,`; the punctuation stays prose after the pill. */
export function splitHandle(value: string): { readonly handle: string; readonly trailing: string } {
  const match = /^(.*?)([.,!?;:)]+)$/.exec(value);
  return match
    ? { handle: match[1] ?? "", trailing: match[2] ?? "" }
    : { handle: value, trailing: "" };
}

export interface MentionSegment {
  readonly start: number;
  readonly text: string;
  readonly mention: MentionTarget | null;
}

/** Splits text into plain runs and resolved mentions. Unknown handles stay text. */
export function segmentMentions(text: string, ownAssistantName?: string): MentionSegment[] {
  // Tokens need trailing whitespace, so a mention can end the message.
  const tokens = collectComposerInlineTokens(`${text} `).filter(
    (token) => token.type === "mention" && token.end <= text.length,
  );
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const { handle, trailing } = splitHandle(token.value);
    const mention = resolveMention(handle, ownAssistantName);
    if (!mention) continue;
    if (token.start > cursor) {
      segments.push({ start: cursor, text: text.slice(cursor, token.start), mention: null });
    }
    const end = token.end - trailing.length;
    segments.push({ start: token.start, text: text.slice(token.start, end), mention });
    cursor = end;
  }
  if (cursor < text.length)
    segments.push({ start: cursor, text: text.slice(cursor), mention: null });
  return segments;
}

/** Teammates a text mentions, once each. Your assistant and agents need no access. */
export function mentionedPeople(text: string): readonly TeamPerson[] {
  const people = new Map<string, TeamPerson>();
  for (const segment of segmentMentions(text)) {
    if (segment.mention?.kind === "person") {
      people.set(segment.mention.person.id, segment.mention.person);
    }
  }
  return [...people.values()];
}

export function mentionsCurrentPerson(text: string): boolean {
  return mentionedPeople(text).some((person) => person.id === currentPerson.id);
}

export interface PendingMention {
  readonly person: TeamPerson;
  readonly by: TeamPerson;
  /** The message with the mention, to jump to. */
  readonly messageId: string;
}

/**
 * Mentions you're part of (you asked, or you were asked) whose person has not
 * posted since. Latest mention per person.
 */
export function unansweredMentions(messages: readonly TeamMessage[]): readonly PendingMention[] {
  const pending = new Map<string, PendingMention>();
  for (const message of messages) {
    if (message.author.kind !== "person") continue;
    pending.delete(message.author.personId);
    const by = findPerson(message.author.personId);
    if (!by) continue;
    for (const person of mentionedPeople(message.body)) {
      const involvesYou = by.id === currentPerson.id || person.id === currentPerson.id;
      if (person.id !== by.id && involvesYou) {
        pending.set(person.id, { person, by, messageId: message.id });
      }
    }
  }
  return [...pending.values()];
}

/** "Needs you" when you were asked, "Waiting on Samir" when you asked. */
export function pendingMentionLabel(pending: Pick<PendingMention, "person">): string {
  return pending.person.id === currentPerson.id
    ? "Needs you"
    : `Waiting on ${firstName(pending.person.name)}`;
}
