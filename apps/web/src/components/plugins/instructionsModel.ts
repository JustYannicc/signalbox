/**
 * AGENTS.md as blocks, per agent role and scope. Supervisors (assistant,
 * section, project, workflow agents) are strictly personal, so their files
 * only exist in your Personal scope. Thread agents do the work and also read
 * group and project files. Each block goes to every harness or to one.
 */
import { HARNESSES, type GroupId, type HarnessId } from "./pluginsModel";

export type InstructionAudience = "all" | HarnessId;

export interface InstructionBlock {
  readonly id: string;
  readonly audience: InstructionAudience;
  readonly text: string;
}

export type InstructionScope = "personal" | "group" | "project";
export type InstructionRole = "assistant" | "section" | "project" | "workflow" | "thread";

export interface InstructionDoc {
  readonly role: InstructionRole;
  readonly scope: InstructionScope;
  readonly blocks: readonly InstructionBlock[];
}

export const INSTRUCTION_SCOPES: readonly InstructionScope[] = ["personal", "group", "project"];
export const INSTRUCTION_ROLES: readonly InstructionRole[] = [
  "assistant",
  "section",
  "project",
  "workflow",
  "thread",
];

export const SCOPE_INFO: Record<
  InstructionScope,
  { readonly label: string; readonly base: string; readonly groupId?: GroupId }
> = {
  personal: { label: "Personal", base: "~/.agents" },
  group: { label: "Northwind group", base: "northwind.example/agents", groupId: "northwind" },
  project: { label: "merchant-portal project", base: "merchant-portal" },
};

export const ROLE_INFO: Record<
  InstructionRole,
  { readonly label: string; readonly supervisor: boolean; readonly position: string }
> = {
  assistant: { label: "Assistant", supervisor: true, position: "Top level" },
  section: { label: "Section agents", supervisor: true, position: "Run a section" },
  project: { label: "Project agents", supervisor: true, position: "Run a project" },
  workflow: { label: "Workflow agents", supervisor: true, position: "Run an automation" },
  thread: { label: "Thread agents", supervisor: false, position: "Do the work" },
};

/** Supervisors are personal, so they only read your Personal files. */
export function scopesFor(role: InstructionRole): readonly InstructionScope[] {
  return ROLE_INFO[role].supervisor ? ["personal"] : INSTRUCTION_SCOPES;
}

/** The assistant's label is the name its user gave it. */
export function roleLabel(role: InstructionRole, assistantName: string) {
  return role === "assistant" ? assistantName : ROLE_INFO[role].label;
}

/** Thread agents read the plain AGENTS.md; each supervisor role reads its own file beside it. */
export function instructionPath(scope: InstructionScope, role: InstructionRole) {
  const file = role === "thread" ? "AGENTS.md" : `roles/${role}.md`;
  return `${SCOPE_INFO[scope].base}/${file}`;
}

export function docKey(role: InstructionRole, scope: InstructionScope) {
  return `${role}:${scope}`;
}

export function audienceLabel(audience: InstructionAudience) {
  if (audience === "all") return "All harnesses";
  return `${HARNESSES.find((harness) => harness.id === audience)?.label ?? audience} only`;
}

export function blocksFor(blocks: readonly InstructionBlock[], harness: HarnessId) {
  return blocks.filter((block) => block.audience === "all" || block.audience === harness);
}

/** Claude Code reads CLAUDE.md; the rest read AGENTS.md. */
export function instructionFileName(harness: HarnessId) {
  return harness === "claudeAgent" ? "CLAUDE.md" : "AGENTS.md";
}

/** The file one agent actually receives, with a marker where each scope starts. */
export function compileInstructions(
  blocksIn: (scope: InstructionScope) => readonly InstructionBlock[],
  role: InstructionRole,
  harness: HarnessId,
) {
  return scopesFor(role)
    .map((scope) => {
      const text = blocksFor(blocksIn(scope), harness)
        .map((block) => block.text.trim())
        .filter((entry) => entry.length > 0)
        .join("\n\n");
      return text
        ? `<!-- ${SCOPE_INFO[scope].label} · ${instructionPath(scope, role)} -->\n\n${text}`
        : "";
    })
    .filter((section) => section.length > 0)
    .join("\n\n");
}

let newBlockCount = 0;

/** Ids only need to be unique within this page session. */
export function newBlock(audience: InstructionAudience): InstructionBlock {
  newBlockCount += 1;
  return { id: `block-new-${newBlockCount}`, audience, text: "" };
}
