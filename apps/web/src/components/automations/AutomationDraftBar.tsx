/**
 * Shown while an automation has a draft that isn't live: which version runs,
 * a switch between the live and draft diagram and code, and Publish / Discard.
 * A never-published automation has only its draft, so there is nothing to
 * switch to and nothing to discard (Delete covers that).
 */
import type { Automation, AutomationDraft, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { UploadIcon, XIcon } from "lucide-react";

import { automationState } from "../../state/automations";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { confirmDestructive, useAutomationCommand } from "./useAutomationCommand";

/** Which version the diagram and code show while a draft is pending. */
export const DraftSide = Schema.Literals(["live", "draft"]);
export type DraftSide = typeof DraftSide.Type;
const isDraftSide = Schema.is(DraftSide);

export function AutomationDraftBar(props: {
  environmentId: EnvironmentId;
  automation: Automation;
  draft: AutomationDraft;
  side: DraftSide;
  onSideChange: (side: DraftSide) => void;
}) {
  const { environmentId, automation, draft } = props;
  const published = automation.version > 0;
  const publish = useAutomationCommand(automationState.publish, "Couldn't publish the draft");
  const discard = useAutomationCommand(automationState.discardDraft, "Couldn't discard the draft");
  const busy = publish.busy || discard.busy;
  const input = { automationId: automation.id };

  const runPublish = async () => {
    if (await publish.run({ environmentId, input })) {
      toastManager.add({ type: "success", title: `Version ${draft.version} is live` });
    }
  };

  const runDiscard = async () => {
    const confirmed = await confirmDestructive(
      `Discard draft version ${draft.version}? Version ${automation.version} keeps running.`,
    );
    if (confirmed) await discard.run({ environmentId, input });
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t bg-warning/4 px-4 py-2">
      <Badge variant="warning">Draft</Badge>
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        {published
          ? `Version ${draft.version}, saved ${formatRelativeTimeLabel(draft.savedAt)}, isn't live. Runs use version ${automation.version} until you publish it.`
          : `Saved ${formatRelativeTimeLabel(draft.savedAt)}. It won't run until you publish it.`}
      </span>
      {published ? (
        <ToggleGroup
          aria-label="Version shown"
          variant="segmented"
          value={[props.side]}
          onValueChange={(next) => {
            const value = next[0];
            if (isDraftSide(value)) props.onSideChange(value);
          }}
        >
          <Toggle value="live">Live</Toggle>
          <Toggle value="draft">Draft</Toggle>
        </ToggleGroup>
      ) : null}
      <div className="flex items-center gap-1.5">
        {published ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void runDiscard()}>
            <XIcon />
            Discard
          </Button>
        ) : null}
        <Button size="xs" disabled={busy} onClick={() => void runPublish()}>
          <UploadIcon />
          Publish
        </Button>
      </div>
    </div>
  );
}
