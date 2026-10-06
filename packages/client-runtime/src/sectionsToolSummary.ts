import type { T3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";

type SectionAction = Extract<T3McpToolSummaryAction, `section-${string}` | "project-section-move">;

/** Section tools use the same success/failure accounting as other app tools. */
export function summarizeSectionToolAction(
  action: SectionAction,
  context: {
    readonly phrase: (past: string, infinitive: string, object: string) => string;
    readonly times: string;
    readonly created: string;
    readonly sections: string;
    readonly projects: string;
  },
): string {
  const { phrase, times, created, sections, projects } = context;
  switch (action) {
    case "section-list":
      return phrase("Listed", "list", `sections ${times}`);
    case "section-chain":
      return phrase("Read", "read", `project section ancestors ${times}`);
    case "section-create":
      return phrase("Created", "create", created);
    case "section-update":
      return phrase("Renamed", "rename", sections);
    case "section-move":
      return phrase("Moved", "move", sections);
    case "section-delete":
      return phrase("Deleted", "delete", sections);
    case "project-section-move":
      return phrase("Moved", "move", `${projects} between sections`);
  }
}
