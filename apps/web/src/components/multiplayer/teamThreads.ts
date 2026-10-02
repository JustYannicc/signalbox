/**
 * Lookups over the multiplayer fixtures, plus the one piece of local state:
 * visibility the user changed (Share / Make private). Both the Home rows and
 * the item page read it, so a share shows up everywhere. Also resolves loose
 * Home items, private forks and unique drafts to a thread the page can show.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import type { HomeItemStatus } from "../sidebar/sections/homeStatus";
import { findLooseItem } from "../sidebar/sections/sectionModel";
import { defaultScopeFor } from "./containerScope";
import { findFork } from "./forks";
import {
  CURRENT_PERSON_ID,
  TEAMS,
  TEAM_MESSAGES,
  TEAM_PEOPLE,
  TEAM_PROJECTS,
  TEAM_THREADS,
} from "./multiplayerFixtures";
import {
  isDraftThreadId,
  type Team,
  type TeamMessage,
  type TeamPerson,
  type TeamProject,
  type TeamThread,
  type ThreadVisibility,
} from "./multiplayerModel";

const PERSON_BY_ID = new Map(TEAM_PEOPLE.map((person) => [person.id, person] as const));

export function findPerson(personId: string): TeamPerson | undefined {
  return PERSON_BY_ID.get(personId);
}

export function peopleByIds(ids: readonly string[]): readonly TeamPerson[] {
  return ids.flatMap((id) => PERSON_BY_ID.get(id) ?? []);
}

export const currentPerson: TeamPerson = PERSON_BY_ID.get(CURRENT_PERSON_ID) ?? {
  id: CURRENT_PERSON_ID,
  name: "You",
  gradient: "sky",
  email: "",
  role: "Owner",
  title: "",
  assistantName: "Your assistant",
};

export function findTeam(teamId: string): Team | undefined {
  return TEAMS.find((team) => team.id === teamId);
}

export function findTeamProject(projectId: string): TeamProject | undefined {
  return TEAM_PROJECTS.find((project) => project.id === projectId);
}

export function teamProjectsInSection(sectionId: string): readonly TeamProject[] {
  return TEAM_PROJECTS.filter((project) => project.sectionId === sectionId);
}

export function threadsInTeamProject(projectId: string): readonly TeamThread[] {
  return TEAM_THREADS.filter((thread) => thread.projectId === projectId);
}

export function findTeamThread(threadId: string): TeamThread | undefined {
  return TEAM_THREADS.find((thread) => thread.id === threadId);
}

/**
 * Fixture messages, a fork's copied history, or, for an item without a script,
 * its title as the opening message and an agent turn matching its status.
 */
export function messagesForThread(thread: TeamThread): readonly TeamMessage[] {
  const fork = findFork(thread.id);
  if (fork?.sourceType === "thread") {
    const source = resolveSharedThread(fork.sourceId);
    return source ? messagesForThread(source.thread) : [];
  }
  const scripted = TEAM_MESSAGES[thread.id];
  if (scripted) return scripted;
  // Chats started from New only hold what was actually sent (local messages).
  if (isDraftThreadId(thread.id)) return [];
  const ownerId = thread.participantIds[0] ?? CURRENT_PERSON_ID;
  return [
    {
      id: "opener",
      author: { kind: "person", personId: ownerId },
      body: thread.title,
      at: "Earlier",
    },
    unscriptedTurn(thread.title, ownerId, findLooseItem(thread.id)?.status),
  ];
}

/**
 * PLACEHOLDER turn for items without a script: a failed item shows the failing
 * check, anything else is caught mid-work. Never a promise to report back later.
 */
function unscriptedTurn(title: string, ownerId: string, status: HomeItemStatus | undefined) {
  const author = { kind: "agent", name: "Codex", startedById: ownerId } as const;
  if (status === "failed") {
    return {
      id: "reply",
      author,
      at: "Earlier",
      work: [
        {
          label: "Run tests",
          itemType: "command_execution",
          command: "vp test run",
          detail: "2 failed, 41 passed",
          failed: true,
        },
      ],
      body: "Stopped here: 2 tests fail on the first run, before anything was changed. The failing output is above.",
    } satisfies TeamMessage;
  }
  return {
    id: "reply",
    author,
    at: "Earlier",
    live: "thinking",
    reasoning: `“${title}”. Reading the project to find where this starts…`,
    body: "",
  } satisfies TeamMessage;
}

interface VisibilityState {
  overrides: Record<string, ThreadVisibility>;
  setVisibility: (threadId: string, visibility: ThreadVisibility) => void;
}

export const useThreadVisibilityStore = create<VisibilityState>()(
  persist(
    (set) => ({
      overrides: {},
      setVisibility: (threadId, visibility) =>
        set((state) =>
          state.overrides[threadId] === visibility
            ? state
            : { overrides: { ...state.overrides, [threadId]: visibility } },
        ),
    }),
    {
      name: "t3code:multiplayer:visibility:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ overrides: state.overrides }),
    },
  ),
);

export function useThreadVisibility(threadId: string, initial: ThreadVisibility) {
  return useThreadVisibilityStore((state) => state.overrides[threadId]) ?? initial;
}

export interface ResolvedSharedThread {
  readonly thread: TeamThread;
  readonly isDraft: boolean;
  /** Team project id for team threads; Home section id (or `"home"`) otherwise. */
  readonly containerId: string;
}

/** Container id for Home's top level, where loose items without a section live. */
export const HOME_CONTAINER_ID = "home";

/**
 * A fixture thread, a loose Home item, a private fork, or an empty draft
 * (`draft-…` ids). `null` when unknown. Drafts take their kind from `?kind=`
 * and their container from `?project=`; visibility always starts from the
 * container's default. Kind never implies visibility.
 */
export function resolveSharedThread(
  threadId: string,
  search: { readonly project?: string; readonly kind?: TeamThread["kind"] } = {},
): ResolvedSharedThread | null {
  const existing = findTeamThread(threadId);
  if (existing) return { thread: existing, isDraft: false, containerId: existing.projectId };
  const loose = findLooseItem(threadId);
  if (loose) {
    const containerId = loose.sectionId ?? HOME_CONTAINER_ID;
    return {
      isDraft: false,
      containerId,
      thread: {
        id: loose.id,
        projectId: containerId,
        title: loose.title,
        kind: loose.type,
        visibility: loose.scope,
        participantIds: [CURRENT_PERSON_ID],
        lastActiveAt: loose.lastActiveAt,
      },
    };
  }
  const fork = findFork(threadId);
  if (fork?.sourceType === "thread") {
    const source = resolveSharedThread(fork.sourceId);
    if (!source) return null;
    return {
      isDraft: false,
      containerId: source.containerId,
      thread: {
        id: fork.id,
        projectId: source.containerId,
        title: fork.title,
        kind: source.thread.kind,
        visibility: "private",
        participantIds: [CURRENT_PERSON_ID],
        lastActiveAt: fork.createdAt,
      },
    };
  }
  if (!isDraftThreadId(threadId)) return null;
  // No `?project=` means a top-level draft (Home › Chats), private by default.
  const containerId = search.project ?? HOME_CONTAINER_ID;
  const kind = search.kind ?? "chat";
  return {
    isDraft: true,
    containerId,
    thread: {
      id: threadId,
      projectId: containerId,
      title: kind === "task" ? "New task" : "New chat",
      kind,
      visibility: defaultScopeFor(containerId),
      participantIds: [CURRENT_PERSON_ID],
      lastActiveAt: new Date().toISOString(),
    },
  };
}
