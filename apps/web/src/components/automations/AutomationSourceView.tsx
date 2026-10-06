/**
 * The TypeScript file the automation runs, read-only. The diagram is derived
 * from it, so this is the ground truth when the picture leaves a question.
 * `line` highlights and scrolls to the line a diagram node came from. Changes
 * go through an agent, one click away in the toolbar. A draft passes the live
 * source as `compareTo` and opens on what publishing it would change.
 */
import type { Automation, EnvironmentId } from "@t3tools/contracts";
import { changePrompt } from "@t3tools/client-runtime/automations/prompts";
import * as Schema from "effect/Schema";
import { GitBranchIcon, MessageCircleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SourceDiffView } from "./SourceDiffView";
import { useAutomationAgent } from "./useAutomationAgent";

const SourceMode = Schema.Literals(["changes", "code"]);
type SourceMode = typeof SourceMode.Type;
const isSourceMode = Schema.is(SourceMode);

/** Mounts with the highlighted line, so a new line scrolls into view once. */
function ScrollTarget() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "center" });
  }, []);
  return <span ref={ref} aria-hidden />;
}

export function AutomationSourceView(props: {
  environmentId: EnvironmentId;
  automation: Pick<Automation, "id" | "name" | "projectId">;
  source: string;
  line: number | null;
  /** The live source a draft is compared with. */
  compareTo?: string | null;
}) {
  const askAgent = useAutomationAgent(props.environmentId, props.automation);
  // Opened on a line from the diagram, the code itself is what was asked for.
  const [mode, setMode] = useState<SourceMode>(props.line ? "code" : "changes");
  const compareTo = props.compareTo ?? null;
  const showChanges = compareTo !== null && mode === "changes";
  const lines = useMemo(
    () =>
      props.source
        .replace(/\n$/, "")
        .split("\n")
        .map((text, index) => ({ number: index + 1, text })),
    [props.source],
  );
  // Digits plus the gutter padding, so every line number right-aligns.
  const gutterWidth = `calc(${String(lines.length).length}ch + 1rem)`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">The diagram is drawn from this code</span>
        </span>
        {compareTo !== null ? (
          <ToggleGroup
            aria-label="Draft code shown"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (isSourceMode(value)) setMode(value);
            }}
          >
            <Toggle value="changes">Changes</Toggle>
            <Toggle value="code">Code</Toggle>
          </ToggleGroup>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          className="ms-auto"
          onClick={() => void askAgent(changePrompt(props.automation))}
        >
          <MessageCircleIcon />
          Change with agent
        </Button>
      </div>
      <div className="min-h-0 flex-1 bg-code">
        {showChanges ? (
          <SourceDiffView before={compareTo} after={props.source} />
        ) : (
          <ScrollArea className="h-full">
            <pre className="py-3 font-mono text-xs leading-relaxed text-code-foreground">
              <code>
                {lines.map((line) => {
                  const highlighted = line.number === props.line;
                  return (
                    <span
                      key={line.number}
                      className={cn("flex px-4", highlighted && "bg-primary/10")}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "shrink-0 pr-4 text-right tabular-nums select-none",
                          highlighted ? "text-foreground" : "text-muted-foreground/60",
                        )}
                        style={{ width: gutterWidth }}
                      >
                        {highlighted ? <ScrollTarget key={props.line} /> : null}
                        {line.number}
                      </span>
                      <span className="min-w-0 whitespace-pre">{line.text || " "}</span>
                    </span>
                  );
                })}
              </code>
            </pre>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
