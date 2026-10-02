/**
 * When each composer draft was last edited, so Home › Drafts can sort by it.
 * The composer draft store only records when a draft session was created, so
 * this watches it from the outside. Updates are coarsened to a minute per
 * draft: the age label never shows finer, and typing must not re-render the
 * list on every keystroke.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveStorage } from "../../lib/storage";

const RESOLUTION_MS = 60_000;

interface DraftEditTimesState {
  editedAtByDraftKey: Record<string, string>;
}

export const useDraftEditTimes = create<DraftEditTimesState>()(
  persist(() => ({ editedAtByDraftKey: {} }), {
    name: "t3code:sidebar:draft-edit-times:v1",
    version: 1,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
  }),
);

useComposerDraftStore.subscribe((state, previous) => {
  if (state.draftsByThreadKey === previous.draftsByThreadKey) return;
  const now = Date.now();
  const current = useDraftEditTimes.getState().editedAtByDraftKey;
  let next: Record<string, string> | null = null;
  for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
    if (draft === previous.draftsByThreadKey[key]) continue;
    const last = current[key];
    if (last && now - Date.parse(last) < RESOLUTION_MS) continue;
    next ??= { ...current };
    next[key] = new Date(now).toISOString();
  }
  // Forget drafts that are gone, so the record stays as small as the store.
  for (const key of Object.keys(current)) {
    if (!(key in state.draftsByThreadKey) && !(key in state.draftThreadsByThreadKey)) {
      next ??= { ...current };
      delete next[key];
    }
  }
  if (next) useDraftEditTimes.setState({ editedAtByDraftKey: next });
});
