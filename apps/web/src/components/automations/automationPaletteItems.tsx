/**
 * Command palette entries for automations: open the Automations overview, and
 * "Run automation…" to start any automation and land on its run.
 */
import {
  automationSubtitle,
  entryKey,
  sortAutomations,
} from "@t3tools/client-runtime/automations/list";
import { useNavigate } from "@tanstack/react-router";
import { PlayIcon, WorkflowIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { automationState } from "../../state/automations";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { automationRoute, nextRunLabel } from "./automationFormat";
import { useAllAutomations } from "./useAutomations";
import { useAutomationCommand } from "./useAutomationCommand";
import { useOpenAutomations } from "./useOpenAutomation";

export function useAutomationPaletteItems(): Array<
  CommandPaletteActionItem | CommandPaletteSubmenuItem
> {
  const navigate = useNavigate();
  const openAutomations = useOpenAutomations();
  const { entries } = useAllAutomations();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const runNow = useAutomationCommand(automationState.runNow, "Couldn't start a run");

  const open: CommandPaletteActionItem = {
    kind: "action",
    value: "action:automations",
    searchTerms: ["automations", "workflows", "runs", "needs you", "steps"],
    title: "Open automations",
    icon: <WorkflowIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "automations.open",
    run: openAutomations,
  };
  if (entries.length === 0) return [open];

  const run: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:run-automation",
    searchTerms: ["run automation", "start", "trigger", "workflow"],
    title: "Run automation...",
    icon: <PlayIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PlayIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "automations",
        label: "Automations",
        items: sortAutomations(entries, "name").map((entry): CommandPaletteActionItem => {
          const { environmentId, automation } = entry;
          return {
            kind: "action",
            value: `run-automation:${entryKey(entry)}`,
            searchTerms: [automation.name, automation.description ?? ""],
            title: automation.name,
            description: automationSubtitle(automation, nextRunLabel(timestampFormat)),
            icon: <WorkflowIcon className={ITEM_ICON_CLASS} />,
            run: async () => {
              const result = await runNow.run(
                { environmentId, input: { automationId: automation.id } },
                `Couldn't run ${automation.name}`,
              );
              if (!result) return;
              await navigate(
                automationRoute({ environmentId, automationId: automation.id }, result.value.id),
              );
            },
          };
        }),
      },
    ],
  };
  return [open, run];
}
