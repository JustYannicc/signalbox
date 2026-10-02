/**
 * The Source tab: the TypeScript workflow file an automation runs. The source
 * is authoritative and the canvas graph is derived from it, so this is where
 * an automation actually changes. Plain monospace, no highlighting.
 */
import { FileCodeIcon, GitBranchIcon, MessageCircleIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import type { Automation } from "./automationModel";
import { useOpenWorkflowAgent } from "./WorkflowAgent";

export function WorkflowSourceView(props: { automation: Automation }) {
  const openAgent = useOpenWorkflowAgent();
  const { source } = props.automation;
  const lines = source.code.replace(/\n$/, "").split("\n");
  // Digits plus the gutter padding, so every line number right-aligns.
  const gutterWidth = `calc(${String(lines.length).length}ch + 1rem)`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <FileCodeIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{source.path}</span>
        </span>
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <GitBranchIcon aria-hidden className="size-3.5" />
          Graph derived from source
        </span>
        <div className="ms-auto">
          <Button size="xs" variant="outline" onClick={() => openAgent(props.automation)}>
            <MessageCircleIcon />
            Change with agent
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-code">
        <ScrollArea className="h-full">
          <pre className="px-4 py-3 font-mono text-xs leading-relaxed text-code-foreground">
            <code>
              {lines.map((line, index) => (
                // Lines never reorder; the index is the line number.
                // eslint-disable-next-line react/no-array-index-key
                <span key={index} className="flex">
                  <span
                    aria-hidden
                    className="shrink-0 pr-4 text-right text-muted-foreground/60 tabular-nums select-none"
                    style={{ width: gutterWidth }}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 whitespace-pre">{line || " "}</span>
                </span>
              ))}
            </code>
          </pre>
        </ScrollArea>
      </div>
    </div>
  );
}
