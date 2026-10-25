import { createFileRoute } from "@tanstack/react-router";

import { TrashSettingsPanel } from "../components/settings/TrashSettings";

// signalbox: Trash (#474).
export const Route = createFileRoute("/settings/trash")({ component: TrashSettingsPanel });
