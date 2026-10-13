/**
 * Saved AGENTS.md edits per level, persisted as prototype state, and which
 * level Plugins › Instructions has open (so an agent page can send you there).
 * Read files with `useInstructionDocs`; resolve what a level gets with
 * `useResolvedInstructions`. Both the agent page and Plugins edit through here.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../lib/prototypeStorage";
import { TOP_LEVEL, type LevelKey } from "../levels/levels";
import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { LEVEL_INSTRUCTIONS } from "./instructionsFixtures";
import {
  resolveInstructions,
  type InstructionAudience,
  type InstructionDocs,
  type LevelInstructions,
} from "./instructionsModel";
import type { HarnessId } from "./pluginsModel";

interface InstructionsState {
  /** Levels you saved, by level; absent means the fixture's file. */
  saved: Record<LevelKey, LevelInstructions>;
  openLevel: LevelKey;
  save: (doc: LevelInstructions) => void;
  open: (level: LevelKey) => void;
}

export const useInstructionsStore = create<InstructionsState>()(
  persist(
    (set) => ({
      saved: {},
      openLevel: TOP_LEVEL,
      save: (doc) => set((state) => ({ saved: { ...state.saved, [doc.level]: doc } })),
      open: (level) => set({ openLevel: level }),
    }),
    {
      name: "t3code:plugins:instructions:v1",
      version: 1,
      storage: prototypeStorage(),
      partialize: (state) => ({ saved: state.saved }),
    },
  ),
);

const FIXTURE_DOCS: InstructionDocs = Object.fromEntries(
  LEVEL_INSTRUCTIONS.map((doc) => [doc.level, doc]),
);

export function useInstructionDocs(): InstructionDocs {
  const saved = useInstructionsStore((state) => state.saved);
  return useMemo(() => ({ ...FIXTURE_DOCS, ...saved }), [saved]);
}

/**
 * What one audience at `level` reads, following live Home placement. Pass an
 * unsaved `draft` to see it in place of its level's saved file.
 */
export function useResolvedInstructions(
  level: LevelKey,
  audience: InstructionAudience,
  harness: HarnessId,
  draft?: LevelInstructions,
) {
  const saved = useInstructionDocs();
  const docs = useMemo(() => (draft ? { ...saved, [draft.level]: draft } : saved), [draft, saved]);
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  return useMemo(
    () => resolveInstructions(level, audience, harness, docs, { projectSectionOverrides }),
    [audience, docs, harness, level, projectSectionOverrides],
  );
}
