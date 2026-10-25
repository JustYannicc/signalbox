import type { SectionMcpToolSummaryAction, T3McpToolDefinition } from "./t3McpToolTypes.ts";

export type { SectionMcpToolSummaryAction } from "./t3McpToolTypes.ts";

export function sectionMcpToolDefinitions(
  define: (
    labels: T3McpToolDefinition["labels"],
    action: SectionMcpToolSummaryAction,
  ) => T3McpToolDefinition,
) {
  return {
    t3_section_list: define(["List", "Listing", "Listed", "sections"], "section-list"),
    t3_project_section_chain: define(
      ["Read", "Reading", "Read", "a project's section ancestors"],
      "section-chain",
    ),
    t3_section_create: define(["Create", "Creating", "Created", "a section"], "section-create"),
    t3_section_update: define(["Update", "Updating", "Updated", "a section"], "section-update"),
    t3_section_move: define(["Move", "Moving", "Moved", "a section"], "section-move"),
    t3_section_delete: define(["Delete", "Deleting", "Deleted", "a section"], "section-delete"),
    t3_project_move_to_section: define(
      ["Move", "Moving", "Moved", "a project between sections"],
      "project-section-move",
    ),
  };
}
