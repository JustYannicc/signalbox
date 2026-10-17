/**
 * Command palette entries for automations: "Open automation…" reaches every
 * automation wherever it lives (each names its folder), "Run automation…"
 * starts one and lands on its run, and the triggers and steps reference.
 */
import {
  automationSubtitle,
  entryKey,
  sortAutomations,
} from "@t3tools/client-runtime/automations/list";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenIcon, PlayIcon, WorkflowIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { automationState } from "../../state/automations";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { useProjectHomeLabels } from "../sidebar/folders/useProjectHomeLabel";
import { automationRoute, nextRunLabel } from "./automationFormat";
import { useAllAutomations } from "./useAutomations";
import { useAutomationCommand } from "./useAutomationCommand";

export function useAutomationPaletteItems(): Array<
  CommandPaletteActionItem | CommandPaletteSubmenuItem
> {
  const navigate = useNavigate();
  const { entries } = useAllAutomations();
  const homeLabelOf = useProjectHomeLabels();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const runNow = useAutomationCommand(automationState.runNow, "Couldn't start a run");

  const reference: CommandPaletteActionItem = {
    kind: "action",
    value: "action:automation-steps",
    searchTerms: ["automation", "triggers", "steps", "reference", "workflows"],
    title: "Automation triggers and steps",
    icon: <BookOpenIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/automations" });
    },
  };
  if (entries.length === 0) return [reference];

  const nextRun = nextRunLabel(timestampFormat);
  // Each automation's words once, for both submenus.
  const described = sortAutomations(entries, "name").map((entry) => {
    const { environmentId, automation } = entry;
    const home = homeLabelOf(environmentId, automation.projectId);
    return {
      entry,
      searchTerms: [automation.name, automation.description ?? "", home ?? ""],
      description: [home, automationSubtitle(automation, nextRun)].filter(Boolean).join(" · "),
    };
  });
  const item = (
    { entry, searchTerms, description }: (typeof described)[number],
    value: string,
    run: () => Promise<void>,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value: `${value}:${entryKey(entry)}`,
    searchTerms,
    title: entry.automation.name,
    description,
    icon: <WorkflowIcon className={ITEM_ICON_CLASS} />,
    run,
  });

  const open: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:open-automation",
    searchTerms: ["open automation", "automations", "workflows", "runs", "needs you"],
    title: "Open automation...",
    shortcutCommand: "automations.open",
    icon: <WorkflowIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <WorkflowIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "automations",
        label: "Automations",
        items: described.map((each) =>
          item(each, "open-automation", async () => {
            const { environmentId, automation } = each.entry;
            await navigate(automationRoute({ environmentId, automationId: automation.id }));
          }),
        ),
      },
    ],
  };

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
        items: described.map((each) =>
          item(each, "run-automation", async () => {
            const { environmentId, automation } = each.entry;
            const result = await runNow.run(
              { environmentId, input: { automationId: automation.id } },
              `Couldn't run ${automation.name}`,
            );
            if (!result) return;
            await navigate(
              automationRoute({ environmentId, automationId: automation.id }, result.value.id),
            );
          }),
        ),
      },
    ],
  };
  return [open, run, reference];
}
