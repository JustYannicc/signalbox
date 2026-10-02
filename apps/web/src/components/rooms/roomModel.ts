/**
 * Rooms: assistant-to-assistant chats, a core item type next to chats and
 * tasks. Each assistant speaks for its owner and only shares what the owner's
 * policy allows; the owners can watch and step in. Like any item, a room is
 * shared or private (default from its section) and can be archived. UI prototype.
 */
import type { ThreadVisibility } from "../multiplayer/multiplayerModel";

export type RoomStatus = "open" | "done";

export interface SharePolicy {
  /** Whose policy, by person id. */
  readonly ownerId: string;
  readonly mayShare: readonly string[];
  readonly neverShares: readonly string[];
}

export interface ContactCard {
  readonly name: string;
  readonly role: string;
  readonly email: string;
  readonly context: string;
}

export type RoomMessageBody =
  | { readonly kind: "text"; readonly text: string }
  /** An assistant checking its owner's policy before answering. */
  | { readonly kind: "policy-check"; readonly text: string }
  | { readonly kind: "contact"; readonly text: string; readonly contact: ContactCard }
  | { readonly kind: "declined"; readonly text: string; readonly withheld: string };

export interface RoomMessage {
  readonly id: string;
  /** "assistant": the person's assistant speaking for them. "person": the owner stepped in. */
  readonly speaker: "assistant" | "person";
  readonly personId: string;
  readonly body: RoomMessageBody;
  readonly at: string;
  /** Attached file names, shown as chips. */
  readonly files?: readonly string[];
}

export interface Room {
  readonly id: string;
  readonly title: string;
  /** Owners of the two assistants; the first one opened the room. */
  readonly ownerIds: readonly [string, string];
  readonly status: RoomStatus;
  /** Whose move it is while open; your own id means the room needs you. */
  readonly waitingOnId?: string;
  /**
   * Where the room is listed in Home: `section:<id>` or `team-project:<id>`.
   * Rooms live in any container, like tasks and chats.
   */
  readonly containerKey: string;
  /** The Home section whose default scope (and team) applies to the room. */
  readonly sectionId: string;
  /** Set when the room departs from its section's default scope. */
  readonly visibility?: ThreadVisibility;
  readonly lastActiveAt: string;
  readonly messages: readonly RoomMessage[];
  readonly policies: readonly SharePolicy[];
  /** One-tap answers offered while the room waits on you. */
  readonly quickReplies?: readonly string[];
  /** Shown once the exchange is done. */
  readonly outcome?: {
    readonly shared: readonly string[];
    readonly declined: readonly string[];
    readonly next: string;
  };
}

/** A fresh, unique room id with someone's assistant (`new-<personId>-<suffix>`). */
export function newRoomId(personId: string): string {
  return `new-${personId}-${Date.now().toString(36)}`;
}

/** The person a `newRoomId` was opened with, or `null`. */
export function personIdOfNewRoom(roomId: string): string | null {
  const match = /^new-([^-]+)(?:-.+)?$/.exec(roomId);
  return match?.[1] ?? null;
}
