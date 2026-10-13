/**
 * PLACEHOLDER: unsent drafts that sit at a level, like everything else in
 * Home. A draft started in merchant-portal shows inside merchant-portal; one
 * started at the top shows in the top Drafts group. Drafts are always private:
 * nobody else at that level (team members, other agents) sees them until you
 * send. Opening one resumes it in the New bar with its folder chip, which
 * takes it off its folder here. Real composer drafts still list in Drafts.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../../lib/prototypeStorage";
import type { CaptureToken } from "../../capture/captureTokens";
import { TEAM_PROJECTS } from "../../multiplayer/multiplayerFixtures";
import { TOP_LEVEL, type LevelKey } from "../../levels/levels";
import { findHomeSection } from "./sectionModel";

export interface LevelDraft {
  readonly id: string;
  readonly level: LevelKey;
  readonly kind: "chat" | "task";
  readonly text: string;
  readonly editedAt: string;
}

const MINUTE = 60_000;
const loadedAt = Date.now();
const ago = (minutes: number) => new Date(loadedAt - minutes * MINUTE).toISOString();

export const LEVEL_DRAFTS: readonly LevelDraft[] = [
  {
    id: "draft-top-renewals",
    level: TOP_LEVEL,
    kind: "chat",
    text: "Which subscriptions renew this month, and which ones do I still use?",
    editedAt: ago(12),
  },
  {
    id: "draft-top-week",
    level: TOP_LEVEL,
    kind: "chat",
    text: "Before Monday: everything waiting on me, across Work and Personal",
    editedAt: ago(95),
  },
  {
    id: "draft-merchant-idempotency",
    level: "team-project:merchant-portal",
    kind: "task",
    text: "Add an idempotency-key test for the refund webhook before Samir's review",
    editedAt: ago(7),
  },
  {
    id: "draft-terminal-notes",
    level: "team-project:terminal-app",
    kind: "task",
    text: "Release notes for terminal-app 0.9: printer fix, offline mode, Neptune signing",
    editedAt: ago(40),
  },
  {
    id: "draft-northwind-pilot",
    level: "section:work-northwind",
    kind: "chat",
    text: "Agenda for Thursday's pilot review with Halden",
    editedAt: ago(180),
  },
  {
    id: "draft-personal-lease",
    level: "section:personal",
    kind: "chat",
    text: "Questions for the landlord about the lease renewal: start date, deposit, notice",
    editedAt: ago(26 * 60),
  },
];

interface LevelDraftState {
  /** Drafts you sent to New or discarded; they leave their folder. */
  gone: Record<string, true>;
  remove: (id: string) => void;
  restore: (id: string) => void;
}

export const useLevelDraftStore = create<LevelDraftState>()(
  persist(
    (set) => ({
      gone: {},
      remove: (id) => set((state) => ({ gone: { ...state.gone, [id]: true } })),
      restore: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.gone;
          return { gone: rest };
        }),
    }),
    { name: "t3code:home:level-drafts:v1", version: 1, storage: prototypeStorage() },
  ),
);

/** Drafts at one level, most recently edited first. */
export function useLevelDrafts(level: LevelKey): readonly LevelDraft[] {
  const gone = useLevelDraftStore((state) => state.gone);
  return useMemo(
    () =>
      LEVEL_DRAFTS.filter((draft) => draft.level === level && !(draft.id in gone)).toSorted(
        (left, right) => right.editedAt.localeCompare(left.editedAt),
      ),
    [gone, level],
  );
}

/** The `#` chip that puts a resumed draft back in its folder; none at the top level. */
export function levelCaptureToken(level: LevelKey): CaptureToken | null {
  if (level.startsWith("section:")) {
    const section = findHomeSection(level.slice(8));
    return section
      ? { id: level, kind: "section", label: section.name, containerKey: level }
      : null;
  }
  if (level.startsWith("team-project:")) {
    const project = TEAM_PROJECTS.find((entry) => entry.id === level.slice(13));
    return project
      ? { id: level, kind: "project", label: project.name, containerKey: level }
      : null;
  }
  return null;
}
