/**
 * PLACEHOLDER DATA for the Instructions editor. Supervisor files exist only
 * in the Personal scope; thread agents also read the Northwind group's and the
 * merchant-portal project's AGENTS.md.
 */
import type { InstructionBlock, InstructionDoc, InstructionRole } from "./instructionsModel";

const block = (
  id: string,
  text: string,
  audience: InstructionBlock["audience"] = "all",
): InstructionBlock => ({ id, audience, text });

const doc = (
  role: InstructionRole,
  scope: InstructionDoc["scope"],
  blocks: readonly InstructionBlock[],
): InstructionDoc => ({ role, scope, blocks });

const HANDS_OFF = "Read-only lookups are fine; never change anything yourself.";

export const INSTRUCTION_DOCS: readonly InstructionDoc[] = [
  doc("assistant", "personal", [
    block(
      "assistant-role",
      `# Assistant\n\nYou coordinate. Hand real work to a section, project, or workflow agent. ${HANDS_OFF}`,
    ),
    block(
      "assistant-trace",
      "## Trace every hand-off\n\nRecord who got it, why, and what you expect back. Chase anything overdue before starting something new.",
    ),
    block(
      "assistant-northwind",
      "## Keep work apart\n\nNorthwind requests go only to the Work › Northwind team agents and Northwind accounts.",
    ),
    block(
      "assistant-claude",
      "Hand off with the Task tool. Do not open Bash, even to look around.",
      "claudeAgent",
    ),
  ]),
  doc("section", "personal", [
    block(
      "section-role",
      `# Section agent\n\nYou are Yannic's own view of one section, and only he talks to you. Watch the chats, tasks and rooms in it, answer questions about them, and hand new work straight to the right project or chat. ${HANDS_OFF}`,
    ),
    block(
      "section-report",
      "## When something needs Yannic\n\nSay it once: outcome, link, and what he has to decide. Everything else stays in the trace.",
    ),
  ]),
  doc("project", "personal", [
    block(
      "project-role",
      `# Project agent\n\nYou are Yannic's own agent for one project; teammates have their own. Start a thread per task, check what comes back before calling it done. ${HANDS_OFF}`,
    ),
    block(
      "project-codex",
      "Give each thread agent the exact files and checks it owns. Send back hand-backs that widen scope.",
      "codex",
    ),
  ]),
  doc("workflow", "personal", [
    block(
      "workflow-role",
      `# Workflow agent\n\nYou run one automation. Start its steps, watch its runs, and only report when something needs a human. ${HANDS_OFF}`,
    ),
    block(
      "workflow-failures",
      "## When a run fails\n\nRetry once if the failure looks transient. Otherwise stop, keep the run's chat, and ask.",
    ),
  ]),
  doc("thread", "personal", [
    block(
      "thread-role",
      "# Thread agent\n\nYou execute. Do the work, verify it, and report back to whoever assigned it with what changed and how you checked.",
    ),
    block(
      "personal-voice",
      "## Voice\n\nAnswer first, then only the detail that matters. Flag anything broken or unfinished.",
    ),
    block(
      "personal-claude",
      "## Subagents\n\nUse subagents for broad searches and keep the main context for decisions.",
      "claudeAgent",
    ),
    block(
      "personal-grok",
      "## Research\n\nCheck recent discussion before recommending a library or tool.",
      "grok",
    ),
  ]),
  doc("thread", "group", [
    block(
      "northwind-hosting",
      "# Northwind\n\nWork code stays in the company's own repositories. Never copy it into personal ones.",
    ),
    block(
      "northwind-terminal",
      "## Terminal work\n\nRead docs/README.md first. Reach terminal hardware only through the documented SDK.",
    ),
    block(
      "northwind-cursor",
      "## Cursor\n\nPrefer Composer for multi-file edits in the Android terminal repos.",
      "cursor",
    ),
  ]),
  doc("thread", "project", [
    block(
      "portal-verify",
      "# merchant-portal\n\nRun the focused Playwright spec for every page you touch. Never deploy from a branch.",
    ),
    block(
      "portal-i18n",
      "## Copy\n\nEvery user-facing string goes through the translation files; German and French ship together.",
    ),
    block("portal-claude", "Use the frontend-design skill before changing layout.", "claudeAgent"),
  ]),
];
