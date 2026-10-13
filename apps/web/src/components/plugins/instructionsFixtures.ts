/**
 * PLACEHOLDER DATA: the AGENTS.md at each level. The top level's rules reach
 * every level; Work keeps its file to itself; Northwind's "Voice" overrides
 * the top level's for everything inside the team, and terminal-app's
 * "Terminal work" overrides Northwind's there. Edits live in `instructionsStore`.
 */
import { TOP_LEVEL } from "../levels/levels";
import type { InstructionBlock, LevelInstructions } from "./instructionsModel";

const block = (
  id: string,
  text: string,
  harness: InstructionBlock["harness"] = "all",
): InstructionBlock => ({ id, harness, text });

export const LEVEL_INSTRUCTIONS: readonly LevelInstructions[] = [
  {
    level: TOP_LEVEL,
    reach: "below",
    agent: [
      block(
        "top-agent-role",
        "# Level agents\n\nYou represent your level and coordinate the threads, tasks and automations in it. Hand real work to a thread. Read-only lookups are fine; never change anything yourself.",
      ),
      block(
        "top-agent-trace",
        "## Trace every hand-off\n\nRecord who got it, why, and what you expect back. Chase anything overdue before starting something new.",
      ),
      block(
        "top-agent-asking",
        "## Asking up\n\nNeed something above your level? Ask the agent above. It lends access for the task, or does the work itself and hands back only what you need.",
      ),
      block(
        "top-agent-runs",
        "## When an automation run fails\n\nRetry once if the failure looks transient. Otherwise stop, keep the run's chat, and ask.",
      ),
      block(
        "top-agent-claude",
        "Hand off with the Task tool. Do not open Bash, even to look around.",
        "claudeAgent",
      ),
    ],
    threads: [
      block(
        "top-threads-role",
        "# Threads\n\nYou execute. Do the work, verify it, and report back to whoever assigned it with what changed and how you checked.",
      ),
      block(
        "top-threads-voice",
        "## Voice\n\nAnswer first, then only the detail that matters. Flag anything broken or unfinished.",
      ),
      block(
        "top-threads-claude",
        "## Subagents\n\nUse subagents for broad searches and keep the main context for decisions.",
        "claudeAgent",
      ),
      block(
        "top-threads-grok",
        "## Research\n\nCheck recent discussion before recommending a library or tool.",
        "grok",
      ),
    ],
  },
  {
    level: "section:work",
    reach: "here",
    agent: [
      block(
        "work-agent-apart",
        "## Keep work apart\n\nNorthwind requests go to the Northwind agent and Northwind accounts.",
      ),
    ],
    threads: [
      block(
        "work-threads-scope",
        "# Work\n\nThreads started directly in Work are quick lookups across its folders. Anything bigger belongs in a project.",
      ),
    ],
  },
  {
    level: "section:work-northwind",
    reach: "below",
    agent: [
      block(
        "northwind-agent-role",
        "# Northwind agent\n\nThe Northwind team shares you: anyone in it can talk to you, so keep private chats out of your answers. Start a thread per task and check what comes back before calling it done.",
      ),
      block(
        "northwind-agent-codex",
        "Give each thread the exact files and checks it owns. Send back hand-backs that widen scope.",
        "codex",
      ),
    ],
    threads: [
      block(
        "northwind-hosting",
        "# Northwind\n\nWork code stays in the company's own repositories. Never copy it into personal ones.",
      ),
      block(
        "northwind-voice",
        "## Voice\n\nWrite for teammates: plain sentences, link the ticket, no personal shorthand.",
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
    ],
  },
  {
    level: "team-project:merchant-portal",
    reach: "below",
    agent: [],
    threads: [
      block(
        "portal-verify",
        "# merchant-portal\n\nRun the focused Playwright spec for every page you touch. Never deploy from a branch.",
      ),
      block(
        "portal-i18n",
        "## Copy\n\nEvery user-facing string goes through the translation files; German and French ship together.",
      ),
      block(
        "portal-claude",
        "Use the frontend-design skill before changing layout.",
        "claudeAgent",
      ),
    ],
  },
  {
    level: "team-project:terminal-app",
    reach: "below",
    agent: [],
    threads: [
      block(
        "terminal-work",
        "## Terminal work\n\nRead docs/README.md and the local Neptune Javadocs first. Use only documented Neptune APIs; generic Android APIs are forbidden. Support is unknown until it runs on the exact A920 firmware.",
      ),
    ],
  },
  {
    level: "section:personal",
    reach: "below",
    agent: [],
    threads: [
      block(
        "personal-repos",
        "## Repositories\n\nPersonal projects live on GitHub; use the gh CLI for issues and PRs.",
      ),
    ],
  },
];
