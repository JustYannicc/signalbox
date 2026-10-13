/**
 * PLACEHOLDER DATA for what newcomers get at team levels: the Northwind team
 * and its projects, which inherit it. Delete with the other plugin fixtures
 * once presets come from the server.
 */
import type { LevelKey } from "../levels/levels";
import type { DefaultItem, DefaultsPreset } from "./defaultsModel";

const preset = (
  level: LevelKey,
  name: string,
  rest: Pick<DefaultsPreset, "items" | "removes">,
): DefaultsPreset => ({ id: level, level, name, ...rest });

const skill = (id: string, detail: string): DefaultItem => ({
  id: `skill:${id}`,
  kind: "skills",
  name: id,
  detail,
});

const shared = (id: string, name: string, glyph: string, detail: string): DefaultItem => ({
  id: `connection:${id}`,
  kind: "connections",
  name,
  detail,
  glyph,
  connection: "shared",
});

const own = (
  id: string,
  name: string,
  glyph: string,
  detail: string,
  optional = false,
): DefaultItem => ({
  id: `connection:${id}`,
  kind: "connections",
  name,
  detail,
  glyph,
  connection: "own",
  optional,
});

export const DEFAULTS_PRESETS: readonly DefaultsPreset[] = [
  preset("section:work-northwind", "Northwind team", {
    removes: [],
    items: [
      shared("slack", "Slack · Northwind workspace", "Sl", "Set up by admins"),
      shared("jira", "Jira · Northwind Jira", "J", "Set up by admins"),
      shared("confluence", "Confluence · Northwind wiki", "Co", "Set up by admins"),
      shared("sentry", "Sentry · Northwind Sentry", "Se", "Set up by admins"),
      own("gmail-work", "Gmail · Work account", "M", "Each member connects their own"),
      own(
        "calendar-work",
        "Google Calendar · Work calendar",
        "Ca",
        "Each member connects their own",
      ),
      own("github", "GitHub", "Gh", "Each member connects their own"),
      skill("customer-email-triage", "Published by you in Northwind"),
      skill("northwind-expenses", "Published by Flynn in Northwind"),
      skill("diagnosing-bugs", "Also in Personal"),
      skill("northwind-terminal", "Reaches every project inside"),
      {
        id: "plugin:code-review",
        kind: "plugins",
        name: "code-review",
        detail: "Claude Code plugin",
        harness: "claudeAgent",
      },
      {
        id: "plugin:commit-commands",
        kind: "plugins",
        name: "commit-commands",
        detail: "Claude Code plugin",
        harness: "claudeAgent",
      },
      {
        id: "plugin:figma",
        kind: "plugins",
        name: "figma",
        detail: "Codex plugin",
        harness: "codex",
      },
      {
        id: "instructions:thread",
        kind: "instructions",
        name: "Northwind AGENTS.md",
        detail: "Team rules for its agent and threads",
      },
      {
        id: "model:northwind-claude",
        kind: "models",
        name: "Northwind Claude pool",
        detail: "Reaches every project inside; the nearest pool wins",
        harness: "claudeAgent",
      },
      {
        id: "model:northwind-codex",
        kind: "models",
        name: "Northwind Codex pool",
        detail: "Reaches every project inside; the nearest pool wins",
        harness: "codex",
      },
    ],
  }),
  preset("team-project:merchant-portal", "merchant-portal", {
    // Its own Codex pool is nearer than Northwind's, so it replaces it here.
    removes: ["plugin:figma", "model:northwind-codex"],
    items: [
      shared(
        "vercel-northwind",
        "Vercel · Northwind team",
        "▲",
        "Preview deployments for the portal",
      ),
      own(
        "drive-personal",
        "Google Drive · Personal",
        "Dr",
        "Connect your own personal Google if you keep mockups there",
        true,
      ),
      skill("frontend-design", "From skills.sh"),
      {
        id: "instructions:portal",
        kind: "instructions",
        name: "merchant-portal AGENTS.md",
        detail: "Project rules on top of the team's",
      },
      {
        id: "model:merchant-portal-codex",
        kind: "models",
        name: "merchant-portal Codex",
        detail: "The project's own pool, nearer than Northwind's",
        harness: "codex",
      },
    ],
  }),
  preset("team-project:terminal-app", "terminal-app", {
    removes: ["skill:customer-email-triage", "plugin:figma"],
    items: [
      own("play-console", "Google Play Console", "Pl", "Each member connects their own"),
      {
        id: "instructions:thread-terminal",
        kind: "instructions",
        name: "terminal-app AGENTS.md",
        detail: "Neptune only, on top of the team's",
      },
    ],
  }),
];
