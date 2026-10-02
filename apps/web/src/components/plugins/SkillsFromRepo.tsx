/**
 * "From a repo…": install skills.sh skills straight from a repository, for
 * people who know the repo. Everyone else installs from the Marketplace.
 */
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { comingSoon } from "./pluginsPrimitives";

export function SkillsFromRepo() {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const command = `npx skills add ${repo.trim() || "owner/repo"}`;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "install command" });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-sm px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
        />
        From a repo…
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-2 px-3 pt-2 sm:px-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              size="sm"
              font="mono"
              value={repo}
              onChange={(event) => setRepo(event.currentTarget.value)}
              placeholder="vercel-labs/agent-skills"
              aria-label="Repository"
              className="sm:max-w-72"
            />
            <Button
              size="sm"
              disabled={!repo.trim()}
              onClick={() => comingSoon(`Install skills from ${repo.trim()}`)}
            >
              Install
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 py-1 pr-1 pl-3 sm:max-w-md">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {command}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={isCopied ? "Copied" : "Copy install command"}
              onClick={() => copyToClipboard(command)}
            >
              {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            </Button>
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
