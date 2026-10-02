/**
 * Chat vs Task. Jev will classify each thread at creation; until then a
 * deterministic title heuristic stands in. The kind changes display (and what
 * the model is told), never tool access. A Chat that starts real work switches
 * itself to Task; the user's flip is kept locally and always wins. Chats
 * auto-archive after a week idle; Tasks never do.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../../lib/storage";
import { formatRelativeTimeLabel } from "../../../timestampFormat";

export type ThreadKind = "chat" | "task";

export const CHAT_ARCHIVE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const TASK_WORDS =
  /\b(fix|implement|add|build|refactor|migrate|update|remove|delete|create|ship|deploy|write|rename|port|wire|bump|release|test|debug|review|feat|bug)\b/i;
const CHAT_OPENERS = /^(how|why|what|which|when|where|who|can|could|should|is|are|does|do)\b/i;

function kindFromTitle(title: string): ThreadKind | null {
  const trimmed = title.trim();
  if (trimmed.endsWith("?") || CHAT_OPENERS.test(trimmed)) return "chat";
  return TASK_WORDS.test(trimmed) ? "task" : null;
}

export interface ThreadClassification {
  readonly kind: ThreadKind;
  /** Set when a Chat switched itself to Task because it started real work. */
  readonly switchNote: string | null;
}

/**
 * Placeholder for Jev's call. `hasWorkspace` (a branch or worktree) counts as
 * real work: a thread that reads like a Chat but has one switched to Task.
 */
export function classifyThread(input: {
  readonly title: string;
  readonly hasWorkspace?: boolean;
  /** When the real work started, for the switch note. */
  readonly workStartedAt?: string | null;
}): ThreadClassification {
  const byTitle = kindFromTitle(input.title);
  if (byTitle === "chat" && input.hasWorkspace) {
    return { kind: "task", switchNote: taskSwitchNote(input.workStartedAt ?? null) };
  }
  return { kind: byTitle ?? (input.hasWorkspace ? "task" : "chat"), switchNote: null };
}

/** Why a Chat became a Task: "started editing files 2h ago" (time omitted when unknown). */
export function taskSwitchNote(startedAt: string | null): string {
  const when = startedAt ? ` ${formatRelativeTimeLabel(startedAt)}` : "";
  return `started editing files${when}`;
}

export function classifyThreadKind(input: {
  readonly title: string;
  readonly hasWorkspace?: boolean;
}): ThreadKind {
  return classifyThread(input).kind;
}

interface ThreadKindState {
  /** Keyed by thread key (or fixture chat id); only user flips are stored. */
  overrides: Record<string, ThreadKind>;
  setKind: (key: string, kind: ThreadKind) => void;
  resetKind: (key: string) => void;
}

export const useThreadKindStore = create<ThreadKindState>()(
  persist(
    (set) => ({
      overrides: {},
      setKind: (key, kind) =>
        set((state) =>
          state.overrides[key] === kind
            ? state
            : { overrides: { ...state.overrides, [key]: kind } },
        ),
      resetKind: (key) =>
        set((state) => {
          if (!(key in state.overrides)) return state;
          const { [key]: _removed, ...overrides } = state.overrides;
          return { overrides };
        }),
    }),
    {
      name: "t3code:sidebar:thread-kind:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ overrides: state.overrides }),
    },
  ),
);

/** The effective kind for one row, plus whether the user overrode Jev. */
export function useThreadKind(key: string, classified: ThreadKind) {
  const override = useThreadKindStore((state) => state.overrides[key]);
  return { kind: override ?? classified, overridden: override !== undefined };
}

/**
 * A chat's auto-archive countdown once it has idled a day: "Archives in 3d".
 * `lastDay` is true on the final day, the only time the row shows it.
 */
export function chatExpiry(
  lastActiveAt: string,
  now = Date.now(),
): { readonly label: string; readonly lastDay: boolean } | null {
  const lastActiveMs = Date.parse(lastActiveAt);
  if (Number.isNaN(lastActiveMs)) return null;
  const idleDays = Math.floor((now - lastActiveMs) / DAY_MS);
  if (idleDays < 1) return null;
  const daysLeft = CHAT_ARCHIVE_AFTER_DAYS - idleDays;
  return daysLeft <= 1
    ? { label: "Archives today", lastDay: true }
    : { label: `Archives in ${daysLeft}d`, lastDay: false };
}
