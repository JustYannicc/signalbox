/**
 * PLACEHOLDER DATA for team and project defaults. Delete with the other
 * plugin fixtures once presets come from the server.
 */
import type { DefaultItem, DefaultsPreset } from "./defaultsModel";

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
  {
    id: "northwind",
    name: "Northwind team",
    kind: "team",
    groupId: "northwind",
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
      skill("diagnosing-bugs", "Shared from Personal"),
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
        detail: "northwind.example/agents/AGENTS.md",
      },
      {
        id: "model:claude-team",
        kind: "models",
        name: "Claude Team",
        detail: "Pooled seats via CLIProxyAPI",
        harness: "claudeAgent",
      },
      {
        id: "model:chatgpt-business",
        kind: "models",
        name: "ChatGPT Business",
        detail: "Pooled seats via CLIProxyAPI",
        harness: "codex",
      },
    ],
  },
  {
    id: "merchant-portal",
    name: "merchant-portal",
    kind: "project",
    inherits: "northwind",
    groupId: "northwind",
    removes: ["plugin:figma"],
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
        detail: "Project instructions",
      },
    ],
  },
  {
    id: "terminal-app",
    name: "terminal-app",
    kind: "project",
    inherits: "northwind",
    groupId: "northwind",
    removes: ["skill:customer-email-triage", "plugin:figma"],
    items: [
      skill("northwind-terminal", "Neptune APIs and PAX rules"),
      own("play-console", "Google Play Console", "Pl", "Each member connects their own"),
      {
        id: "instructions:thread-terminal",
        kind: "instructions",
        name: "terminal-app AGENTS.md",
        detail: "Neptune only",
      },
    ],
  },
  {
    id: "t3code",
    name: "t3code",
    kind: "project",
    groupId: "personal",
    removes: [],
    items: [
      own("github-t3", "GitHub · JustYannicc", "Gh", "Your own account"),
      shared("linear-t3", "Linear · T3 Tools", "Li", "Set up for T3 Tools maintainers"),
      skill("test-t3-app", "Project skill"),
      skill("effect-v4", "Personal skill"),
      {
        id: "instructions:t3-thread",
        kind: "instructions",
        name: "t3code AGENTS.md",
        detail: "Project instructions",
      },
      {
        id: "model:claude-max",
        kind: "models",
        name: "Claude Max",
        detail: "Your subscription via CLIProxyAPI",
        harness: "claudeAgent",
      },
    ],
  },
];
