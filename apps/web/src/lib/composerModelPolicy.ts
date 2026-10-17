import type { ModelSelection } from "@t3tools/contracts";
import type { ResolvedProjectSettings } from "@t3tools/shared/projectSettings";
import { getAntigravitySendBlockReason } from "../components/ChatView.logic";

export function configuredProjectModelSelection(
  activeProjectSettings: Pick<ResolvedProjectSettings, "settings" | "sources">,
): ModelSelection | null {
  return activeProjectSettings.sources.defaultModelSelection === "project"
    ? (activeProjectSettings.settings.defaultModelSelection ?? null)
    : null;
}

export function composerModelSendBlockReason(
  snapshot: Parameters<typeof getAntigravitySendBlockReason>[0],
  selectedModel: string,
): string | null {
  return selectedModel.trim() === ""
    ? "Choose a model or set a default in Settings."
    : getAntigravitySendBlockReason(snapshot, selectedModel);
}
