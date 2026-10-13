/**
 * Whether the workspace (rail, sidebar and their titlebar controls) shows on
 * the top layer. It stays out of sight until you go looking for it; leaving
 * the top layer hides it again for next time. Read by `AppSidebarLayout`.
 */
import { create } from "zustand";

export const TOP_LAYER_PATH = "/today";

interface WorkspaceVisibility {
  revealed: boolean;
  setRevealed: (revealed: boolean) => void;
}

export const useWorkspaceVisibility = create<WorkspaceVisibility>()((set) => ({
  revealed: false,
  setRevealed: (revealed) => set({ revealed }),
}));

/** True while the top layer keeps the workspace out of sight. */
export function useWorkspaceHidden(pathname: string): boolean {
  const revealed = useWorkspaceVisibility((state) => state.revealed);
  return pathname === TOP_LAYER_PATH && !revealed;
}
