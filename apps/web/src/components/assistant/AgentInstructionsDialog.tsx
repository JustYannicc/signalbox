/**
 * Header icon on agent pages: edit the AGENTS.md of the level this agent
 * represents, for the agent itself or for the threads there, next to what
 * they actually read with everything inherited from above. Same files as
 * Plugins › Instructions.
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ScrollTextIcon } from "lucide-react";
import { useState } from "react";

import { LevelOptionsProvider } from "../levels/LevelOptionsProvider";
import type { LevelOption } from "../levels/levelOptions";
import type { LevelKey } from "../levels/levels";
import {
  InstructionsBlocks,
  InstructionsLevelHeader,
  useInstructionDraft,
} from "../plugins/InstructionsLevelEditor";
import { type InstructionAudience } from "../plugins/instructionsModel";
import { InstructionsPreview } from "../plugins/InstructionsPreview";
import { useInstructionsStore } from "../plugins/instructionsStore";
import type { HarnessId } from "../plugins/pluginsModel";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function LevelInstructionsEditor(props: { level: LevelKey }) {
  const draft = useInstructionDraft(props.level);
  const [audience, setAudience] = useState<InstructionAudience>("agent");
  const [harness, setHarness] = useState<HarnessId>("claudeAgent");
  return (
    <>
      <DialogPanel>
        <InstructionsLevelHeader
          level={props.level}
          draft={draft}
          audience={audience}
          onAudienceChange={setAudience}
        />
        <InstructionsBlocks draft={draft} audience={audience} />
        <InstructionsPreview
          level={props.level}
          audience={audience}
          harness={harness}
          onHarnessChange={setHarness}
          draft={draft.doc}
        />
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => useInstructionsStore.getState().open(props.level)}
          render={
            <Link
              to="/plugins"
              search={{ section: "instructions", level: props.level, audience }}
            />
          }
        >
          All levels in Plugins
          <ArrowUpRightIcon />
        </Button>
      </DialogFooter>
    </>
  );
}

function DialogBody(props: { level: LevelOption | null; agentName: string }) {
  const { level } = props;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{props.agentName} instructions</DialogTitle>
        <DialogDescription>
          {level
            ? `The AGENTS.md at ${level.label}, for this agent and for the threads there.`
            : "This agent isn't placed in Home, so it has no level to read instructions from."}
        </DialogDescription>
      </DialogHeader>
      {level ? <LevelInstructionsEditor key={level.key} level={level.key} /> : null}
    </>
  );
}

export function AgentInstructionsDialog(props: { level: LevelOption | null; agentName: string }) {
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Instructions" />}
            />
          }
        >
          <ScrollTextIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Instructions</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-w-2xl">
        {/* The editor and preview name levels and agents from the provider. */}
        <LevelOptionsProvider>
          <DialogBody level={props.level} agentName={props.agentName} />
        </LevelOptionsProvider>
      </DialogPopup>
    </Dialog>
  );
}
