/**
 * Header icon on agent pages that shows the agent's supervisor AGENTS.md, read
 * from Plugins › Instructions, where it is edited.
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ScrollTextIcon } from "lucide-react";

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
import type { AgentFixture } from "./agentFixtures";
import { MarkdownViewer } from "./MarkdownDoc";
import { supervisorAgentsMd } from "./supervisorInstructions";

export function AgentInstructionsDialog(props: { agent: AgentFixture; agentName: string }) {
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
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.agentName} instructions</DialogTitle>
          <DialogDescription>
            Every {props.agent.kind} agent reads this AGENTS.md. Threads it starts read their
            project's own.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <MarkdownViewer label="AGENTS.md" value={supervisorAgentsMd(props.agent.kind)} />
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            render={
              <Link
                to="/plugins"
                search={{ section: "instructions", role: props.agent.kind, scope: "personal" }}
              />
            }
          >
            Edit in Plugins
            <ArrowUpRightIcon />
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
