import { createFileRoute } from "@tanstack/react-router";

import { BlockLibrarySettings } from "../components/settings/BlockLibrarySettings";

function SettingsBlocksRoute() {
  const { level } = Route.useSearch();
  return <BlockLibrarySettings level={level} />;
}

// signalbox: the block library (#1056).
export const Route = createFileRoute("/settings/blocks")({
  validateSearch: (raw: Record<string, unknown>) =>
    typeof raw.level === "string" && raw.level.trim() ? { level: raw.level } : {},
  component: SettingsBlocksRoute,
});
