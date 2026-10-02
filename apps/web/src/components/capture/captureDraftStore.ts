/**
 * The New bar's unsent state: text, `#`/`@` chips, and link chips survive
 * closing the bar and reloads, so the next open picks up where you left off
 * and Home › Drafts can list it. Files are live `File` objects and are not
 * kept; they drop when the bar closes.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { isAssistantToken, withToken, type CaptureLink, type CaptureToken } from "./captureTokens";

export interface CaptureDraft {
  readonly text: string;
  readonly tokens: ReadonlyArray<CaptureToken>;
  readonly links: ReadonlyArray<CaptureLink>;
  /** ISO time of the last edit; null when empty. */
  readonly updatedAt: string | null;
}

const EMPTY_DRAFT: CaptureDraft = { text: "", tokens: [], links: [], updatedAt: null };

interface CaptureDraftState extends CaptureDraft {
  setText: (text: string) => void;
  addTokens: (tokens: ReadonlyArray<CaptureToken>) => void;
  removeToken: (id: string) => void;
  addLink: (link: CaptureLink) => void;
  removeLink: (id: string) => void;
  restore: (draft: CaptureDraft) => void;
  clear: () => void;
}

/** Typed work: text, links, or a tag. The preselected assistant chip alone is not a draft. */
export function captureDraftHasContent(draft: CaptureDraft): boolean {
  return (
    draft.text.trim().length > 0 ||
    draft.links.length > 0 ||
    draft.tokens.some((token) => !isAssistantToken(token))
  );
}

const touched = (next: Omit<CaptureDraft, "updatedAt">): CaptureDraft => ({
  ...next,
  updatedAt: captureDraftHasContent({ ...next, updatedAt: null }) ? new Date().toISOString() : null,
});

export const useCaptureDraftStore = create<CaptureDraftState>()(
  persist(
    (set) => ({
      ...EMPTY_DRAFT,
      setText: (text) => set((state) => touched({ ...state, text })),
      addTokens: (tokens) =>
        set((state) => {
          const next = tokens.reduce(withToken, state.tokens);
          return next === state.tokens ? state : touched({ ...state, tokens: next });
        }),
      removeToken: (id) =>
        set((state) => touched({ ...state, tokens: state.tokens.filter((t) => t.id !== id) })),
      addLink: (link) =>
        set((state) =>
          state.links.some((existing) => existing.url === link.url)
            ? state
            : touched({ ...state, links: [...state.links, link] }),
        ),
      removeLink: (id) =>
        set((state) => touched({ ...state, links: state.links.filter((l) => l.id !== id) })),
      restore: (draft) => set(draft),
      clear: () => set(EMPTY_DRAFT),
    }),
    {
      name: "t3code:capture-draft:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        text: state.text,
        tokens: state.tokens,
        links: state.links,
        updatedAt: state.updatedAt,
      }),
    },
  ),
);

export function readCaptureDraft(): CaptureDraft {
  const { text, tokens, links, updatedAt } = useCaptureDraftStore.getState();
  return { text, tokens, links, updatedAt };
}
