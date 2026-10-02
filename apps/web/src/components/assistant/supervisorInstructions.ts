/**
 * A supervisor's AGENTS.md, read from the same documents Plugins › Instructions
 * edits (one source of truth). Blocks for one harness are marked as such.
 * PLACEHOLDER: the Instructions editor keeps edits in memory, so this shows its
 * default text.
 */
import { INSTRUCTION_DOCS } from "../plugins/instructionsFixtures";
import { audienceLabel, type InstructionRole } from "../plugins/instructionsModel";

export function supervisorAgentsMd(role: Exclude<InstructionRole, "thread">): string {
  const blocks = INSTRUCTION_DOCS.filter((doc) => doc.role === role).flatMap((doc) => doc.blocks);
  if (blocks.length === 0) return "No instructions for this role yet.";
  return blocks
    .map((block) =>
      block.audience === "all"
        ? block.text
        : `<!-- ${audienceLabel(block.audience)} -->\n${block.text}`,
    )
    .join("\n\n");
}
