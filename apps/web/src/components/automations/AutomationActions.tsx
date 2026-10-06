/**
 * The automation page's controls: On/Paused, Run now (or Replay for an
 * automation only a webhook starts, since a run without its payload means
 * little), and an overflow menu: change it with an agent, duplicate, rerun
 * with a run's input, the webhook URL, Delete. Every command reports its own
 * failure.
 */
import type { Automation, AutomationRunDetail, EnvironmentId } from "@t3tools/contracts";
import { runActions, type RunAction } from "@t3tools/client-runtime/automations/list";
import { changePrompt, duplicatePrompt } from "@t3tools/client-runtime/automations/prompts";
import { useNavigate } from "@tanstack/react-router";
import {
  CopyIcon,
  HistoryIcon,
  LinkIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { automationState } from "../../state/automations";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useAutomationAgent } from "./useAutomationAgent";
import { confirmDestructive, useAutomationCommand } from "./useAutomationCommand";

const RUN_ICON: Record<RunAction["id"], typeof PlayIcon> = { run: PlayIcon, replay: HistoryIcon };

export function AutomationActions(props: {
  environmentId: EnvironmentId;
  automation: Automation;
  /** The run on screen, whose input Replay reuses. */
  shownRun: AutomationRunDetail | null;
  /** Shows the run that just started. */
  onRunStarted: (runId: string) => void;
}) {
  const { environmentId, automation, shownRun } = props;
  const navigate = useNavigate();
  const setEnabled = useAutomationCommand(automationState.setEnabled, "Couldn't pause it");
  const runNow = useAutomationCommand(automationState.runNow, "Couldn't start a run");
  const remove = useAutomationCommand(automationState.remove, "Couldn't delete the automation");
  const busy = setEnabled.busy || runNow.busy || remove.busy;
  const askAgent = useAutomationAgent(environmentId, automation);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const webhookUrl =
    automation.webhookPath && httpBaseUrl
      ? new URL(automation.webhookPath, httpBaseUrl).toString()
      : null;
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "Webhook URL copied" }),
  });
  const { lead, extra } = runActions(automation, shownRun);
  // Only a draft so far: nothing to run or turn on until it's published.
  const unpublished = automation.version === 0;

  const toggle = (enabled: boolean) =>
    void setEnabled.run(
      { environmentId, input: { automationId: automation.id, enabled } },
      enabled ? "Couldn't turn it on" : "Couldn't pause it",
    );

  const start = async (action: RunAction) => {
    const result = await runNow.run({
      environmentId,
      input: {
        automationId: automation.id,
        ...(action.input === undefined ? {} : { input: action.input }),
      },
    });
    if (result) props.onRunStarted(result.value.id);
  };

  const destroy = async () => {
    const confirmed = await confirmDestructive(
      `Delete "${automation.name}"? Its runs stop and its history goes with it.`,
    );
    if (!confirmed) return;
    const result = await remove.run({ environmentId, input: { automationId: automation.id } });
    if (result) void navigate({ to: "/automations" });
  };

  const LeadIcon = RUN_ICON[lead.id];
  const ExtraIcon = extra ? RUN_ICON[extra.id] : null;

  return (
    <div className="flex shrink-0 items-center gap-3">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Switch
          size="sm"
          checked={automation.enabled}
          disabled={busy || unpublished}
          onCheckedChange={toggle}
        />
        {automation.enabled ? "On" : "Paused"}
      </label>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || unpublished}
        onClick={() => void start(lead)}
      >
        <LeadIcon />
        {lead.title}
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={busy}
              aria-label={`More actions for ${automation.name}`}
            />
          }
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => void askAgent(changePrompt(automation))}>
            <MessageCircleIcon />
            Change with agent
          </MenuItem>
          <MenuItem onClick={() => void askAgent(duplicatePrompt(automation))}>
            <CopyIcon />
            Duplicate with agent
          </MenuItem>
          <MenuSeparator />
          {extra && ExtraIcon && !unpublished ? (
            <MenuItem onClick={() => void start(extra)}>
              <ExtraIcon />
              {extra.title}
            </MenuItem>
          ) : null}
          {webhookUrl ? (
            <MenuItem onClick={() => copyToClipboard(webhookUrl, undefined)}>
              <LinkIcon />
              Copy webhook URL
            </MenuItem>
          ) : null}
          {(extra && !unpublished) || webhookUrl ? <MenuSeparator /> : null}
          <MenuItem variant="destructive" onClick={() => void destroy()}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
