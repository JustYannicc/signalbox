/**
 * Shapes and section list for the Plugins page. The page is a UI prototype:
 * these types describe what the fixtures pretend the server will send.
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { Icon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";

export const PluginsSection = Schema.Literals([
  "overview",
  "marketplace",
  "groups",
  "connections",
  "harness-plugins",
  "skills",
  "instructions",
]);
export type PluginsSection = typeof PluginsSection.Type;
export const decodePluginsSection = Schema.decodeUnknownOption(PluginsSection);

export const PLUGINS_SECTION_LABEL: Record<PluginsSection, string> = {
  overview: "Overview",
  marketplace: "Marketplace",
  groups: "Groups",
  connections: "Connections",
  "harness-plugins": "Codex & Claude plugins",
  skills: "Skills",
  instructions: "Instructions",
};

export const HARNESS_IDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export interface Harness {
  readonly id: HarnessId;
  readonly label: string;
  readonly icon: Icon | null;
}

const HARNESS_LABEL: Record<HarnessId, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

export const HARNESSES: readonly Harness[] = HARNESS_IDS.map((id) => ({
  id,
  label: HARNESS_LABEL[id],
  icon: PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(id)] ?? null,
}));

export type IntegrationKind = "mcp" | "openapi" | "graphql";
export type AuthState = "connected" | "needs-reauth" | "error" | "none";

export interface IntegrationTool {
  readonly name: string;
  readonly description: string;
}

/** An access group id, e.g. "northwind" or "personal". See groupsModel.ts. */
export type GroupId = string;

/** Admins own org-provided items; employees can still bring their own accounts. */
export type AddedBy = "admins" | "you";

/** One signed-in account of an integration. Its label is what models see. */
export interface ConnectionAccount {
  readonly id: string;
  /** Display name shown to models as "<Integration> · <label>". */
  readonly label: string;
  readonly identity: string;
  readonly auth: AuthState;
  readonly authDetail?: string;
  readonly groups: readonly GroupId[];
  readonly addedBy: AddedBy;
}

export interface Integration {
  readonly id: string;
  readonly name: string;
  /** One or two characters for the monochrome mark. */
  readonly glyph: string;
  readonly kind: IntegrationKind;
  /** Direct servers run from a harness config instead of through Executor. */
  readonly via: "executor" | "direct";
  readonly transport?: "stdio" | "http";
  readonly auth: AuthState;
  /** Summary across accounts, or the server's own state when there are none. */
  readonly authDetail?: string;
  readonly accounts: readonly ConnectionAccount[];
  /** Groups for account-less (direct) servers; account-backed ones use their accounts'. */
  readonly groups?: readonly GroupId[];
  readonly toolCount: number;
  readonly tools: readonly IntegrationTool[];
  readonly scopes: readonly string[];
  readonly harnesses: readonly HarnessId[];
}

export interface HarnessPlugin {
  readonly id: string;
  readonly harness: HarnessId;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly updateAvailable?: string;
  readonly groups: readonly GroupId[];
}

/** "team" skills are published inside a group without anyone touching git. */
export type SkillSource = "personal" | "project" | "plugin" | "skills.sh" | "team";

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  /** The plugin or project that ships it, when not personal. */
  readonly origin?: string;
  readonly harnesses: readonly HarnessId[];
  readonly groups: readonly GroupId[];
}

export interface ExecutorStatus {
  readonly state: "connected" | "disconnected";
  readonly url: string;
  readonly account: string;
  readonly version: string;
  readonly lastSync: string;
}

export const KIND_LABEL: Record<IntegrationKind, string> = {
  mcp: "MCP",
  openapi: "OpenAPI",
  graphql: "GraphQL",
};

export function isApiKind(kind: IntegrationKind) {
  return kind === "openapi" || kind === "graphql";
}

export function needsAttention(integration: Integration) {
  return integration.auth === "needs-reauth" || integration.auth === "error";
}

/** The name a model sees for one account, e.g. "Gmail · Work account". */
export function connectionDisplayName(integration: Integration, label: string) {
  return `${integration.name} · ${label}`;
}

/** Every group an integration reaches, through any of its accounts. */
export function integrationGroups(integration: Integration): readonly GroupId[] {
  if (integration.accounts.length === 0) return integration.groups ?? [];
  return [...new Set(integration.accounts.flatMap((account) => account.groups))];
}

/** The Connections page cuts by kind; MCP includes direct servers, APIs are Executor-only. */
export type ConnectionKindFilter = "all" | "mcp" | "api";

export function matchesKind(integration: Integration, filter: ConnectionKindFilter) {
  if (filter === "all") return true;
  return filter === "mcp" ? integration.kind === "mcp" : isApiKind(integration.kind);
}

/** "Only on Codex, Claude Code" when an item skips some harnesses; nothing when it reaches all. */
export function harnessRestriction(enabled: readonly HarnessId[]) {
  if (enabled.length === HARNESS_IDS.length) return null;
  if (enabled.length === 0) return "Off for every harness";
  return `Only on ${HARNESSES.filter((harness) => enabled.includes(harness.id))
    .map((harness) => harness.label)
    .join(", ")}`;
}

export function countSections(input: {
  readonly integrations: readonly Integration[];
  readonly plugins: readonly HarnessPlugin[];
  readonly skills: readonly Skill[];
  readonly groupCount: number;
  readonly listingCount: number;
}): Record<PluginsSection, number | null> {
  return {
    overview: null,
    marketplace: input.listingCount,
    groups: input.groupCount,
    connections: input.integrations.length,
    "harness-plugins": input.plugins.length,
    skills: input.skills.length,
    instructions: null,
  };
}
