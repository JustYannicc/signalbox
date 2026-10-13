/**
 * Turns each team-project demo draft into a real T3 draft, once, in the demo
 * project with the same name, so it opens in the composer like any T3 draft
 * and lists inside that project. Mount once where Home's projects are known.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { newDraftId } from "../../../lib/utils";
import type { HomeProjectEntry } from "../useHomeSidebarData";
import { LEVEL_DRAFTS, teamProjectNameOf, useLevelDraftStore } from "./levelDrafts";

export function useSeedProjectDrafts(projectEntries: readonly HomeProjectEntry[]) {
  useEffect(() => {
    const { seeded, gone, markSeeded } = useLevelDraftStore.getState();
    for (const draft of LEVEL_DRAFTS) {
      if (draft.id in seeded || draft.id in gone) continue;
      const name = teamProjectNameOf(draft.level);
      if (!name) continue;
      const member = projectEntries.find((entry) => entry.group.displayName === name)?.group
        .memberProjects[0];
      if (!member) continue;
      const draftId = newDraftId();
      const store = useComposerDraftStore.getState();
      store.setProjectDraftThreadId(scopeProjectRef(member.environmentId, member.id), draftId, {
        createdAt: draft.editedAt,
      });
      store.setPrompt(draftId, draft.text);
      markSeeded(draft.id, draftId);
    }
  }, [projectEntries]);
}
