/**
 * Messages sent from this device in team chats and rooms. PLACEHOLDER: they
 * append locally (with a canned agent turn in chats, see `agentReply.ts`) so
 * the page reads like a conversation; nothing leaves the device. Live agent
 * turns are persisted settled, so a reload never shows one stuck mid-work.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import type { RoomMessage } from "../rooms/roomModel";
import { shortId, type SystemEvent, type TeamMessage } from "./multiplayerModel";

const NONE: readonly never[] = [];

interface LocalMessagesState {
  team: Record<string, readonly TeamMessage[]>;
  rooms: Record<string, readonly RoomMessage[]>;
  addTeam: (itemId: string, messages: readonly TeamMessage[]) => void;
  addRoom: (roomId: string, messages: readonly RoomMessage[]) => void;
  /** Swaps in a new version of a message by id, e.g. a live turn once it settles. */
  replaceTeam: (itemId: string, message: TeamMessage) => void;
}

/** A live turn with its live flags dropped: every step completed, the answer shown. */
export function settleTurn(message: TeamMessage): TeamMessage {
  if (!message.live) return message;
  const { live: _live, reasoning: _reasoning, approval: _approval, ...rest } = message;
  return message.work
    ? { ...rest, work: message.work.map(({ running: _running, ...step }) => step) }
    : rest;
}

function settleAll(
  team: Record<string, readonly TeamMessage[]>,
): Record<string, readonly TeamMessage[]> {
  return Object.fromEntries(
    Object.entries(team).map(([itemId, messages]) => [itemId, messages.map(settleTurn)]),
  );
}

export const useLocalMessagesStore = create<LocalMessagesState>()(
  persist(
    (set) => ({
      team: {},
      rooms: {},
      addTeam: (itemId, messages) =>
        set((state) => ({
          team: { ...state.team, [itemId]: [...(state.team[itemId] ?? NONE), ...messages] },
        })),
      replaceTeam: (itemId, message) =>
        set((state) => ({
          team: {
            ...state.team,
            [itemId]: (state.team[itemId] ?? NONE).map((existing) =>
              existing.id === message.id ? message : existing,
            ),
          },
        })),
      addRoom: (roomId, messages) =>
        set((state) => ({
          rooms: { ...state.rooms, [roomId]: [...(state.rooms[roomId] ?? NONE), ...messages] },
        })),
    }),
    {
      name: "t3code:multiplayer:local-messages:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      // A reload loses the settle timer, so storage only ever holds finished turns.
      partialize: (state) => ({ team: settleAll(state.team), rooms: state.rooms }),
    },
  ),
);

export function useLocalTeamMessages(itemId: string): readonly TeamMessage[] {
  return useLocalMessagesStore((state) => state.team[itemId]) ?? NONE;
}

export function useLocalRoomMessages(roomId: string): readonly RoomMessage[] {
  return useLocalMessagesStore((state) => state.rooms[roomId]) ?? NONE;
}

/** "14:05", for messages sent now. */
export function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function localMessageId(): string {
  return `local-${shortId()}`;
}

/** Logs a timeline event from this device, e.g. "Yannic made this a task". */
export function logTeamEvent(threadId: string, event: SystemEvent, body: string): void {
  useLocalMessagesStore.getState().addTeam(threadId, [
    {
      id: localMessageId(),
      author: { kind: "system", event },
      body,
      at: nowLabel(),
      createdAt: new Date().toISOString(),
    },
  ]);
}
