/**
 * What publishing a draft changes in the automation's file: added and removed
 * lines against the live version, with unchanged stretches folded away.
 */
import {
  diffCounts,
  foldUnchanged,
  lineDiff,
} from "@t3tools/client-runtime/automations/sourceDiff";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "../ui/scroll-area";

export function SourceDiffView(props: { before: string; after: string }) {
  const { rows, counts, digits } = useMemo(() => {
    const lines = lineDiff(props.before, props.after);
    const last = lines.at(-1);
    return {
      rows: foldUnchanged(lines),
      counts: diffCounts(lines),
      digits: String(Math.max(last?.before ?? 0, last?.after ?? 0)).length,
    };
  }, [props.before, props.after]);
  const gutter = { width: `calc(${digits}ch + 0.75rem)` };

  if (counts.added === 0 && counts.removed === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        The draft's code is the same as the live version's.
      </p>
    );
  }

  return (
    <ScrollArea className="h-full">
      <p className="px-4 pt-3 text-xs text-muted-foreground">
        <span className="text-success-foreground">{`+${counts.added}`}</span>{" "}
        <span className="text-destructive-foreground">{`−${counts.removed}`}</span> lines against
        the live version
      </p>
      <pre className="py-3 font-mono text-xs leading-relaxed text-code-foreground">
        <code>
          {rows.map((row) =>
            row.kind === "gap" ? (
              <span
                key={`gap-${row.from}`}
                className="flex px-4 py-0.5 text-muted-foreground/70 select-none"
              >
                {`⋯ ${row.count} unchanged ${row.count === 1 ? "line" : "lines"}`}
              </span>
            ) : (
              <span
                key={`${row.before ?? ""}:${row.after ?? ""}`}
                className={cn(
                  "flex px-4",
                  row.kind === "added" && "bg-success/10",
                  row.kind === "removed" && "bg-destructive/10",
                )}
              >
                <span
                  aria-hidden
                  className="shrink-0 pr-3 text-right text-muted-foreground/60 tabular-nums select-none"
                  style={gutter}
                >
                  {row.after ?? row.before}
                </span>
                <span
                  className={cn(
                    "w-4 shrink-0 select-none",
                    row.kind === "added" && "text-success-foreground",
                    row.kind === "removed" && "text-destructive-foreground",
                  )}
                >
                  {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
                </span>
                <span className="min-w-0 whitespace-pre">{row.text || " "}</span>
              </span>
            ),
          )}
        </code>
      </pre>
    </ScrollArea>
  );
}
